import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lookup as dnsLookupCb } from 'node:dns';
import { promisify } from 'node:util';

import {
  authenticatedFetch,
  getAPIJSONResult,
  getNetlifyAccessToken,
  NetlifyUnauthError,
  type NetlifySite,
} from '../../utils/api-networking.js';
import { zipAndBuild } from '../deploy-tools/deploy-site.js';
import { appendErrorToLog } from '../../utils/logging.js';
import { decodeJob, encodeJob, fallbackImportSiteName, importSiteName, isBlockedFetchHost, isPrivateAddress, projectMarker } from './job-utils.js';

const dnsLookup = promisify(dnsLookupCb);

// Claude Design discovers export destinations by this literal tool name.
// It MUST match exactly or Netlify will not appear in the "Send to…" menu.
export const IMPORT_TOOL_NAME = 'import-claude-design-from-url';
export const STATUS_TOOL_NAME = 'get-design-import-job-status';

// The source URL has a short TTL and a very low request cap, so it is fetched
// exactly once with no retries.
const FETCH_TIMEOUT_MS = 60_000;
// Self-contained bundles inline images/fonts as data URIs and can be large; this
// caps memory use while staying well above a realistic design size.
const MAX_HTML_BYTES = 30 * 1024 * 1024;

// Tags imported sites so Netlify attributes them to Claude Design (drives the
// "created via" label) instead of falling through to the default "Netlify Drop".
const CREATED_VIA = 'claude_design';

const importInputSchema = {
  url: z
    .string()
    .url()
    .describe('Public HTTPS URL to the design file. Valid for a short time. Fetched server-side.'),
  title: z.string().optional().describe('Suggested title for the imported design.'),
  claude_design_project_id: z
    .string()
    .optional()
    .describe(
      'Stable Claude Design project id. When provided, re-sending the same project updates its existing Netlify site in place instead of creating a new site each time.',
    ),
  account_slug: z
    .string()
    .optional()
    .describe(
      'Optional Netlify team (account) slug to create the site under, e.g. "acme-team". Omit to use your default team.',
    ),
  password: z
    .string()
    .optional()
    .describe(
      'Optional password to protect the imported site. Applied when the site is first created; requires a plan with site password protection. If unavailable the import fails with a clear error.',
    ),
};

const statusInputSchema = {
  job_id: z.string().describe('Job id returned by import-claude-design-from-url.'),
};

type ImportInput = {
  url: string;
  title?: string;
  account_slug?: string;
  password?: string;
  claude_design_project_id?: string;
};
type ImportResult = { site: NetlifySite; deployId: string; jobId: string; updatedExistingSite: boolean };
type StatusResult = { status: 'processing' | 'done' | 'failed'; design_url?: string; state: string };

// === core logic (pure-ish, exported for tests + local verification) ===

export async function runClaudeDesignImport(
  { url, title, account_slug, password, claude_design_project_id: projectId }: ImportInput,
  request?: Request,
): Promise<ImportResult> {
  const html = await fetchDesignHtml(url);

  const existingSite = projectId ? await findSiteForProject(projectId, request) : undefined;
  const site =
    existingSite ??
    (await createImportSite(siteNameCandidates(title, projectId), { account_slug, password }, request));
  if (!existingSite && projectId) {
    await recordProjectIdOnSite(site.id, projectId, request);
  }

  const deployId = await deployHtmlToSite(html, site.id, request);
  return { site, deployId, jobId: encodeJob(site.id, deployId), updatedExistingSite: !!existingSite };
}

export async function getClaudeDesignImportStatus(
  jobId: string,
  request?: Request,
): Promise<StatusResult> {
  const { deployId } = decodeJob(jobId);
  const deploy = await getAPIJSONResult(`/api/v1/deploys/${deployId}`, {}, {}, request);
  const state: string = deploy?.state || 'unknown';
  const status =
    state === 'ready' ? 'done' : state === 'error' || state === 'rejected' ? 'failed' : 'processing';
  return { status, design_url: status === 'done' ? deploy?.ssl_url || deploy?.url : undefined, state };
}

async function fetchDesignHtml(url: string): Promise<string> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error('url must be a valid https URL');
  }
  if (target.protocol !== 'https:') {
    throw new Error('url must be an https URL');
  }
  await assertPublicHost(target.hostname);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchFollowingRedirects(target, controller);
    if (!resp.ok) {
      throw new Error(`could not fetch design from url (status ${resp.status})`);
    }
    return await readBodyWithCap(resp, controller);
  } finally {
    clearTimeout(timeout);
  }
}

// Follows redirects manually so each hop's host is validated BEFORE the request
// fires. Default fetch follows 30x transparently, which would let a public URL
// redirect into an internal host and complete that request (blind SSRF) before a
// post-hoc resp.url check could run.
const MAX_REDIRECTS = 5;

async function fetchFollowingRedirects(start: URL, controller: AbortController): Promise<Response> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname);
    const resp = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'netlify-mcp' },
    });
    if (resp.status < 300 || resp.status >= 400) {
      return resp;
    }
    const location = resp.headers.get('location');
    if (!location) {
      return resp;
    }
    const next = new URL(location, url);
    if (next.protocol !== 'https:') {
      throw new Error('url redirected to a non-https location');
    }
    url = next;
  }
  throw new Error('too many redirects');
}

// Blocks a host that is private by name OR resolves to a private address. The DNS
// check closes the gap where a public hostname points at loopback/RFC1918/metadata
// space. Residual: fetch() re-resolves at connect time, so a rebinding attacker
// racing the TTL between this lookup and the connection is not covered — that needs
// connect-time IP pinning (a custom dispatcher), out of scope here.
async function assertPublicHost(hostname: string): Promise<void> {
  if (isBlockedFetchHost(hostname)) {
    throw new Error('url host is not allowed');
  }
  // Literal IPs are already fully classified by isBlockedFetchHost; only names resolve.
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':')) {
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch {
    throw new Error('could not resolve url host');
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('url host is not allowed');
  }
}

// Streams the body and aborts the moment the accumulated bytes exceed the cap, so
// a missing/lying content-length or a slow-drip response cannot exhaust memory
// before a post-hoc length check would run. Counts bytes, not UTF-16 code units.
async function readBodyWithCap(resp: Response, controller: AbortController): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    throw new Error('could not read design from url');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTML_BYTES) {
      controller.abort();
      throw new Error(`design exceeds the ${MAX_HTML_BYTES}-byte size limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Finds the site a previous send of this project created: a name-filtered lookup
// on the project marker, confirmed against the site's stored metadata so a
// coincidental name match can never cause a deploy onto an unrelated site.
// Best-effort — any lookup failure falls back to creating a fresh site.
async function findSiteForProject(projectId: string, request?: Request): Promise<NetlifySite | undefined> {
  const marker = projectMarker(projectId);
  try {
    const response = await authenticatedFetch(
      `/api/v1/sites?name=${encodeURIComponent(marker)}&filter=all`,
      {},
      request,
    );
    if (!response.ok) return undefined;

    const sites = (await response.json()) as NetlifySite[];
    for (const site of sites.filter((site) => site.name?.includes(marker))) {
      const meta = await authenticatedFetch(`/api/v1/sites/${site.id}/metadata`, {}, request);
      if (!meta.ok) continue;
      const metadata = (await meta.json()) as Record<string, unknown>;
      if (metadata?.claude_design_project_id === projectId) return site;
    }
  } catch (error) {
    appendErrorToLog(`Claude Design project lookup failed (falling back to new site): ${error}`);
  }
  return undefined;
}

// Stores the project id on the new site so future sends can verify the match.
// Best-effort: a failure here degrades re-sends to creating a new site, which is
// strictly better than failing an import that already succeeded.
async function recordProjectIdOnSite(siteId: string, projectId: string, request?: Request): Promise<void> {
  try {
    const response = await authenticatedFetch(
      `/api/v1/sites/${siteId}/metadata`,
      { method: 'PUT', body: JSON.stringify({ claude_design_project_id: projectId }) },
      request,
    );
    if (!response.ok) {
      appendErrorToLog(`Failed to record Claude Design project id on site ${siteId} (${response.status})`);
    }
  } catch (error) {
    appendErrorToLog(`Failed to record Claude Design project id on site ${siteId}: ${error}`);
  }
}

// Names to try when creating the site, in order. When a project id is present,
// every candidate keeps the marker: a Netlify-generated fallback name would
// orphan the site from future re-send lookups (which match the marker in the
// name), silently breaking idempotency for that project.
function siteNameCandidates(title?: string, projectId?: string): string[] {
  const primary = importSiteName(title, projectId);
  if (!primary) return [];
  if (!projectId) return [primary];
  return [primary, fallbackImportSiteName(projectId, randomUUID().slice(0, 6))];
}

class SiteNameTakenError extends Error {}

async function createImportSite(
  nameCandidates: string[],
  { account_slug, password }: { account_slug?: string; password?: string },
  request?: Request,
): Promise<NetlifySite> {
  // account_slug targets a specific team; the sites API reads it from the query
  // string (params[:account_slug]), not the JSON body. Omitted -> user's default team.
  const path = account_slug
    ? `/api/v1/sites?account_slug=${encodeURIComponent(account_slug)}`
    : '/api/v1/sites';

  const attempt = async (extra: object): Promise<NetlifySite> => {
    const body = { created_via: CREATED_VIA, ...(password ? { password } : {}), ...extra };
    const response = await authenticatedFetch(path, { method: 'POST', body: JSON.stringify(body) }, request);

    if (response.status === 401 && request) {
      throw new NetlifyUnauthError();
    }
    if (response.ok) {
      return (await response.json()) as NetlifySite;
    }

    // A 422 about the name/subdomain already being taken is retryable with an
    // auto-generated name. Any other 422 (e.g. password protection or the
    // requested team not available on this plan) is a real error — surface it
    // rather than masking it as a name collision.
    const detail = await response.text().catch(() => '');
    if (response.status === 422 && /name|subdomain|already|taken/i.test(detail)) {
      throw new SiteNameTakenError();
    }
    throw new Error(`failed to create site (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  };

  // Site subdomains are globally unique. Try each candidate in order; if all
  // are taken, let Netlify generate a name so the import still succeeds.
  for (const name of nameCandidates) {
    try {
      return await attempt({ name });
    } catch (error) {
      if (!(error instanceof SiteNameTakenError)) throw error;
    }
  }
  return await attempt({});
}

async function deployHtmlToSite(html: string, siteId: string, request?: Request): Promise<string> {
  const workDir = path.join(os.tmpdir(), `claude-design-${randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });
  try {
    await fs.writeFile(path.join(workDir, 'index.html'), html, 'utf-8');
    // Publish the uploaded files as-is, no build step, so the inlined HTML serves directly.
    await fs.writeFile(path.join(workDir, 'netlify.toml'), '[build]\n  publish = "."\n', 'utf-8');

    const { deployId } = await zipAndBuild({ deployDirectory: workDir, siteId, request });
    if (!deployId) {
      throw new Error('deploy did not start');
    }
    return deployId;
  } catch (error) {
    appendErrorToLog(`Failed to deploy imported design: ${error}`);
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

// === MCP registration (imperative shell) ===

export function registerClaudeDesignImportTool(server: McpServer, remoteMCPRequest?: Request): void {
  server.registerTool(
    IMPORT_TOOL_NAME,
    {
      description:
        'Import a design into Netlify from a publicly fetchable URL. The file is a self-contained HTML bundle with all images, fonts, and styles inlined. Netlify creates a new site, deploys the HTML, and returns a live URL.',
      inputSchema: importInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input: ImportInput) => {
      const authError = await guardAuth(remoteMCPRequest);
      if (authError) return authError;

      try {
        const { site, jobId, updatedExistingSite } = await runClaudeDesignImport(input, remoteMCPRequest);
        const liveUrl = site.ssl_url || site.url;
        const text = [
          updatedExistingSite
            ? `Updated the existing Netlify site for this design: ${liveUrl}`
            : `Imported into Netlify: ${liveUrl}`,
          `Manage in Netlify: ${site.admin_url}`,
          `The deploy is finalizing and the URL goes live momentarily. To confirm it is ready, call ${STATUS_TOOL_NAME} with job_id "${jobId}".`,
        ].join('\n');
        return { content: [{ type: 'text' as const, text }] };
      } catch (error: any) {
        appendErrorToLog(`${IMPORT_TOOL_NAME} failed: ${error}`);
        return {
          content: [{ type: 'text' as const, text: `Failed to import design: ${error?.message || error}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    STATUS_TOOL_NAME,
    {
      description:
        'Check the status of a Claude Design import started by import-claude-design-from-url. Returns processing | done | failed, plus the design URL once done.',
      inputSchema: statusInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ job_id }: { job_id: string }) => {
      const authError = await guardAuth(remoteMCPRequest);
      if (authError) return authError;

      try {
        const result = await getClaudeDesignImportStatus(job_id, remoteMCPRequest);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed to get import status: ${error?.message || error}` }],
          isError: true,
        };
      }
    },
  );
}

// Mirrors the auth handling the domain tools use: in remote mode an unauthenticated
// request propagates NetlifyUnauthError so the handler can issue an OAuth challenge;
// locally it returns a readable error instead.
async function guardAuth(request?: Request) {
  try {
    await getNetlifyAccessToken(request);
    return null;
  } catch (error: any) {
    if (error instanceof NetlifyUnauthError && request) {
      throw new NetlifyUnauthError();
    }
    return {
      content: [{ type: 'text' as const, text: error?.message || 'Failed to get Netlify token' }],
      isError: true,
    };
  }
}
