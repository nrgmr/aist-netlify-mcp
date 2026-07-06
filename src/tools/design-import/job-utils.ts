// Pure helpers for the Claude Design import tool. No I/O, node builtins only —
// kept separate so they can be unit-tested without loading the deploy/network stack.

import { createHash } from 'node:crypto';

// A short, deterministic token derived from the Claude Design project id. It is
// embedded in the site's subdomain so a re-send can find the existing site with a
// single server-side name-filtered lookup (GET /sites?name=<marker>) instead of
// listing every site the user can see. Hashed rather than raw so the public URL
// does not expose the project id.
export function projectMarker(projectId: string): string {
  return `cd-${createHash('sha256').update(projectId).digest('hex').slice(0, 10)}`;
}

// Site name for a fresh import: the readable title slug, suffixed with the
// project marker when a stable project id is available.
export function importSiteName(title?: string, projectId?: string): string | undefined {
  const slug = slugify(title);
  if (!projectId) return slug;
  const marker = projectMarker(projectId);
  return slug ? `${slug}-${marker}` : marker;
}

// Fallback name for when the primary name is already taken (subdomains are
// globally unique — e.g. the same design project imported from a different
// Netlify account). It keeps the marker so a re-send can still find this site
// via the name lookup; the suffix restores uniqueness.
export function fallbackImportSiteName(projectId: string, suffix: string): string {
  return `${projectMarker(projectId)}-${suffix}`;
}

export function slugify(title?: string): string | undefined {
  if (!title) return undefined;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || undefined;
}

export function encodeJob(siteId: string, deployId: string): string {
  return Buffer.from(`${siteId}:${deployId}`).toString('base64url');
}

// Netlify site and deploy ids are hex-ish tokens. The deployId is interpolated
// into an API path (GET /api/v1/deploys/<deployId>), so a value with slashes or
// dot segments could traverse to another authenticated endpoint — reject anything
// that isn't a plain id.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function decodeJob(jobId: string): { siteId: string; deployId: string } {
  const decoded = Buffer.from(jobId, 'base64url').toString('utf-8');
  const sep = decoded.indexOf(':');
  if (sep === -1) {
    throw new Error('invalid job_id');
  }
  const siteId = decoded.slice(0, sep);
  const deployId = decoded.slice(sep + 1);
  if (!ID_PATTERN.test(siteId) || !ID_PATTERN.test(deployId)) {
    throw new Error('invalid job_id');
  }
  return { siteId, deployId };
}

// Classifies a resolved IP address (literal, not a hostname) as non-publicly
// routable: loopback, link-local (incl. the cloud metadata address), and private
// / unique-local ranges. Used both for literal-IP hosts and for the addresses a
// hostname resolves to.
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) — classify on the embedded v4.
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const v4 = (mapped ? mapped[1] : addr).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6 loopback / link-local / unique-local
  return addr === '::1' || addr.startsWith('fe80:') || addr.startsWith('fc') || addr.startsWith('fd');
}

// Rejects destinations that are not publicly routable by their host STRING, so
// the server-side design fetch cannot be pointed at loopback, link-local, or
// private hosts via a literal IP or an obvious internal name. It does NOT resolve
// DNS — a hostname resolving to a private address is caught by the resolver-based
// check in the fetch path, not here.
export function isBlockedFetchHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  const isIpLiteral = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':');
  return isIpLiteral && isPrivateAddress(host);
}
