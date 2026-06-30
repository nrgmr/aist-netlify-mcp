import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  getAPIJSONResult,
  getNetlifyAccessToken,
  NetlifyUnauthError,
  type NetlifySite,
} from '../../utils/api-networking.js';
import { zipAndBuild } from '../deploy-tools/deploy-site.js';
import { appendErrorToLog } from '../../utils/logging.js';
import { decodeJob, encodeJob, slugify } from './job-utils.js';

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

const importInputSchema = {
  url: z
    .string()
    .url()
    .describe('Public HTTPS URL to the design file. Valid for a short time. Fetched server-side.'),
  title: z.string().optional().describe('Suggested title for the imported design.'),
};

const statusInputSchema = {
  job_id: z.string().describe('Job id returned by import-claude-design-from-url.'),
};

type ImportResult = { site: NetlifySite; deployId: string; jobId: string };
type StatusResult = { status: 'processing' | 'done' | 'failed'; design_url?: string; state: string };

// === core logic (pure-ish, exported for tests + local verification) ===

export async function runClaudeDesignImport(
  { url, title }: { url: string; title?: string },
  request?: Request,
): Promise<ImportResult> {
  const html = await fetchDesignHtml(url);
  const site = await createImportSite(slugify(title), request);
  const deployId = await deployHtmlToSite(html, site.id, request);
  return { site, deployId, jobId: encodeJob(site.id, deployId) };
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
  if (!url.startsWith('https://')) {
    throw new Error('url must be an https URL');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'netlify-mcp' } });
    if (!resp.ok) {
      throw new Error(`could not fetch design from url (status ${resp.status})`);
    }

    const declaredSize = Number(resp.headers.get('content-length') || 0);
    if (declaredSize > MAX_HTML_BYTES) {
      throw new Error(`design exceeds the ${MAX_HTML_BYTES}-byte size limit`);
    }

    const html = await resp.text();
    if (html.length > MAX_HTML_BYTES) {
      throw new Error(`design exceeds the ${MAX_HTML_BYTES}-byte size limit`);
    }
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

class SiteNameTakenError extends Error {}

async function createImportSite(name: string | undefined, request?: Request): Promise<NetlifySite> {
  const create = (body: object): Promise<NetlifySite> =>
    getAPIJSONResult(
      '/api/v1/sites',
      { method: 'POST', body: JSON.stringify(body) },
      {
        failureCallback: (response) => {
          // 422 means the chosen name is already taken; anything else is a real failure.
          if (response.status === 422) {
            throw new SiteNameTakenError();
          }
          throw new Error(`failed to create site: ${response.status}`);
        },
      },
      request,
    );

  // Site subdomains are globally unique. If the title-derived name collides,
  // fall back to a Netlify-generated name so the import still succeeds. Any other
  // failure propagates rather than being masked by the fallback.
  if (name) {
    try {
      return await create({ name });
    } catch (error) {
      if (!(error instanceof SiteNameTakenError)) throw error;
    }
  }
  return await create({});
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
    async ({ url, title }: { url: string; title?: string }) => {
      const authError = await guardAuth(remoteMCPRequest);
      if (authError) return authError;

      try {
        const { site, jobId } = await runClaudeDesignImport({ url, title }, remoteMCPRequest);
        const liveUrl = site.ssl_url || site.url;
        const text = [
          `Imported into Netlify: ${liveUrl}`,
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
