import { decryptJWE } from "../functions/mcp-server/utils.ts";
import { debugLog } from "../functions/mcp-server/logging.ts";
import {Config, Context} from '@netlify/edge-functions';

// Escape regex metacharacters so an allowed-path template is matched literally
// (except for our own `:param` placeholders, which are substituted afterwards).
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The proxy is called with a JWE that has a accessToken inside.
// This is to allow us to give a short lived token to something external to
// the MCP server and use it to enrich requests
export default async (req: Request, ctx: Context) => {
  const token = ctx.params?.token as string;

  debugLog('proxy request', { method: req.method, url: req.url, hasToken: !!token });

  if (!token) {
    return new Response('Unauthorized', { status: 401 });
  }
  const decryptedToken = await decryptJWE(token);
  if (!decryptedToken || typeof decryptedToken.accessToken !== 'string') {
    return new Response('Unauthorized', { status: 401 });
  }
  
  const requestedPath = req.url.split(token)[1];

  // Normalize BEFORE the allow-list check so we validate exactly what we forward.
  // `new URL` resolves `../` traversal and other WHATWG normalization; matching
  // against the raw string would let a path that merely *contains* the allowed
  // substring (e.g. `.../builds/../../../accounts/TEAM/env`) slip past the check
  // and then normalize to an endpoint the token was never scoped to reach.
  const url = new URL(requestedPath as string, 'https://api.netlify.com');
  const normalizedPath = url.pathname;

  if (Array.isArray(decryptedToken.apisAllowed)) {
    const isAllowed = decryptedToken.apisAllowed.some(({ path, method }: { path: string; method: string; }) => {
      // Escape regex metacharacters in the allowed path, then turn `:param`
      // placeholders into a bounded segment matcher, and anchor with ^...$ so
      // the whole normalized path must match — not just a substring of it.
      const pattern = '^' + escapeRegExp(path).replace(/:\w+/g, '[\\w\\-]+') + '$';
      const pathMatches = new RegExp(pattern).test(normalizedPath);
      return pathMatches && method === req.method;
    });

    if (!isAllowed) {
      console.error('Unauthorized access attempt to path:', normalizedPath, decryptedToken.apisAllowed);
      return new Response('Forbidden', { status: 403 });
    }
  }

  req.headers.set('Authorization', `Bearer ${decryptedToken.accessToken}`);
  req.headers.delete('host');

  const updatedReq = new Request(url, {
    method: decryptedToken.apiMethod as string | undefined || req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'manual', // prevent automatic redirects
  });
  debugLog('proxy forwarding', { to: url.toString(), method: updatedReq.method });
  return fetch(updatedReq);
};

export const config: Config = {
  path: '/proxy/:token/*'
};
