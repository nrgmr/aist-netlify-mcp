// Pure helpers for the Claude Design import tool. No I/O, no external imports —
// kept separate so they can be unit-tested without loading the deploy/network stack.

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
