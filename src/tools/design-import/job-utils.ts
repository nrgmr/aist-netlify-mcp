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

export function decodeJob(jobId: string): { siteId: string; deployId: string } {
  const decoded = Buffer.from(jobId, 'base64url').toString('utf-8');
  const sep = decoded.indexOf(':');
  if (sep === -1) {
    throw new Error('invalid job_id');
  }
  return { siteId: decoded.slice(0, sep), deployId: decoded.slice(sep + 1) };
}
