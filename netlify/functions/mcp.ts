import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { addCORSHeadersToFetchResp, addCommonHeadersToHandlerResp, headersToHeadersObject, returnNeedsAuthResponse } from "./mcp-server/utils.ts";
import { getContextConsumerConfig, getNetlifyCodingContext } from "../../src/context/coding-context.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPackageVersion } from "../../src/utils/version.ts";
import { z } from "zod";
import { checkCompatibility } from "../../src/utils/compatibility.ts";
import { bindTools } from "../../src/tools/index.ts";
import { registerClaudeDesignImportTool } from "../../src/tools/design-import/import-claude-design.ts";
import { userIsAuthenticated, UNAUTHED_ERROR_PREFIX } from "../../src/utils/api-networking.ts";
import { isClaudeMCPClient } from "../../src/utils/client-detection.ts";
import { debugLog, isVerboseLogging, maskToken, redactSensitive } from "./mcp-server/logging.ts";
import {Config} from "@netlify/functions";

// Netlify serverless function handler
export default async (req: Request) => {

  try {

    debugLog('mcp request', {
      method: req.method,
      url: req.url,
      auth: maskToken(req.headers.get('Authorization')),
    });

    // Handle different HTTP methods
    if (req.method === "POST") {
      return handleMCPPost(req);
    } else if (req.method === "GET") {
      return handleMCPGet();
    } else if (req.method === "DELETE") {
      return handleMCPDelete();
    } else if (req.method === "OPTIONS") { 
      return new Response('', {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "*",
          "Access-Control-Allow-Headers": "*"
        }
      });
    } else {
      return new Response("Method not allowed", { status: 405 });
    }

  } catch (error) {

    console.error("MCP error:", error);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
};


async function handleMCPPost(req: Request) {

  // Read the body once as text so we can tell an empty body (common for
  // probes/health-checks/scanners hitting the public endpoint) apart from
  // malformed/truncated JSON (which may signal a real client or proxy issue).
  const raw = await req.text();

  if (!raw.trim()) {
    // Empty POST — not a real MCP request. Respond without logging noise.
    return jsonRpcError(400, -32600, 'Request body is required');
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    console.error('Invalid JSON in MCP POST body', {
      bytes: raw.length,
      contentType: req.headers.get('content-type'),
      userAgent: req.headers.get('user-agent'),
    });
    return jsonRpcError(400, -32700, 'Parse error: invalid JSON body');
  }

  // Guarded here, not just inside debugLog: building these snapshots walks the
  // whole (attacker-controlled, pre-auth) body and header set, work that must
  // not run per-request in steady state.
  if (isVerboseLogging()) {
    debugLog('mcp post body', { method: body?.method, id: body?.id, params: redactSensitive(body?.params) });

    // Request headers relevant to StreamableHTTP/MCP negotiation. `accept` must
    // include both application/json and text/event-stream or the transport rejects
    // the request; session/protocol headers help correlate the handshake. Only
    // these explicitly named headers are logged — never a full header dump, which
    // would leak credentials carried in headers like x-api-key or x-auth-token.
    debugLog('mcp post request', {
      method: body?.method,
      id: body?.id,
      accept: req.headers.get('accept'),
      contentType: req.headers.get('content-type'),
      mcpSessionId: req.headers.get('mcp-session-id'),
      mcpProtocolVersion: req.headers.get('mcp-protocol-version'),
      userAgent: req.headers.get('user-agent'),
      // origin/referer identify which surface a request comes from; kept for
      // diagnosing client behaviour when verbose logging is enabled.
      origin: req.headers.get('origin'),
      referer: req.headers.get('referer'),
      auth: maskToken(req.headers.get('Authorization')),
      clientInfoName: body?.params?.clientInfo?.name,
    });
  }

  // Check for verbose mode via query parameter
  const url = new URL(req.url);
  const verboseMode = url.searchParams.get('verbose') === 'true';
  debugLog('mcp post handling', { verboseMode });

  // Create a new Request with the body as a string to avoid re-reading issues
  // toReqRes will try to read the body, so we need to provide a fresh request
  const reqWithBody = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(body),
  });

  // Convert the Request object into a Node.js Request object
  const { req: nodeReq, res: nodeRes } = toReqRes(reqWithBody);

  // Right now, the MCP spec is inconcistent on _when_ 
  // 401s can be returned. So, we will always do the auth
  // check, including for init.
  if(!await userIsAuthenticated(req)){
    // If a token was presented but failed validation, signal invalid_token so the
    // client refreshes; if none was sent, send a bare challenge to start auth.
    const tokenPresented = !!req.headers.get('authorization');
    debugLog('mcp auth failed', { method: body?.method, id: body?.id, tokenPresented });
    return returnNeedsAuthResponse(tokenPresented
      ? { error: 'invalid_token', errorDescription: 'The access token is invalid or expired' }
      : undefined);
  }
  debugLog('mcp authenticated', { method: body?.method, id: body?.id });

  const server = new McpServer({
    name: "netlify",
    title: "Netlify",
    version: getPackageVersion(),
    websiteUrl: "https://www.netlify.com",
    icons: [{ src: "https://www.netlify.com/favicon/icon.svg", mimeType: "image/svg+xml" }],
  });

  const contextConsumer = await getContextConsumerConfig();
  const availableContextTypes = Object.keys(contextConsumer?.contextScopes || {});
  const creationTypeEnum = z.enum(availableContextTypes as [string, ...string[]]);
  
  server.tool(
    "get-netlify-coding-context",
    "ALWAYS call when writing code. Required step before creating or editing any type of functions, Netlify sdk/library  usage, etc. Use other operations for project management.",
    { creationType: creationTypeEnum },
    async ({creationType}: {creationType: z.infer<typeof creationTypeEnum>}) => {
  
      checkCompatibility();
  
      const context = await getNetlifyCodingContext(creationType);
      const text = context?.content || '';
  
      return ({
        content: [{type: "text", text}]
      });
    }
  );

  // Standalone top-level tool (not part of the domain selector) so Claude Design
  // can discover it by its exact name and list Netlify as a "Send to" destination.
  // Registered only for Claude clients, which keeps it out of every non-Claude
  // agent's tools/list. Within Claude it can still surface on other surfaces
  // (Claude Code, claude.ai chat) because they share the connector's MCP URL and
  // Claude does not filter tools per surface today; a per-URL marker is not an
  // option since that URL is inherited from the claude.ai connector.
  if (isClaudeMCPClient(req, body)) {
    registerClaudeDesignImportTool(server, req);
  }

  try {
    await bindTools(server, req, verboseMode);
  } catch (error: any) {

    console.error('Failed to bind tools to MCP server:', error);
    return new Response('Failed to bind tools to MCP server', {status: 500});
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  transport.onerror = (error) => {
    console.error("Transport error:", error);
  };

  await server.connect(transport);

  await transport.handleRequest(nodeReq, nodeRes, body);

  nodeRes.on("close", () => {
    transport.close();
    server.close();
  });

  const response = await toFetchResponse(nodeRes);
  try {
    const returnData = await response.clone().text();

    debugLog('mcp response', {
      method: body?.method,
      id: body?.id,
      status: response.status,
      contentType: response.headers.get('content-type'),
      // truncate to keep logs readable; enough to see the JSON-RPC result/error shape
      body: returnData.length > 2000 ? `${returnData.slice(0, 2000)}…(${returnData.length} bytes)` : returnData,
    });

    if(returnData.includes(UNAUTHED_ERROR_PREFIX)){
      // A downstream Netlify call rejected the token mid-request — it's no longer
      // valid, so flag invalid_token rather than a bare challenge.
      console.error("Unauthorized error detected in response:", returnData);
      return returnNeedsAuthResponse({ error: 'invalid_token', errorDescription: 'The Netlify access token is no longer valid' });
    }

  } catch (error) {
    console.error("Error parsing response JSON:", error);
  }

  return addCORSHeadersToFetchResp(response);
}

// Build a JSON-RPC error response so clients get a consistent, parseable shape.
function jsonRpcError(status: number, code: number, message: string) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: { "Content-Type": "application/json" }
    }
  );
}

// For the stateless server, GET requests are used to initialize
// SSE connections which are stateful. Therefore, we don't need
// to handle GET requests but we can signal to the client this error.
function handleMCPGet() {
  return jsonRpcError(405, -32002, "Method not allowed.");
}

function handleMCPDelete() {
  return jsonRpcError(405, -32002, "Method not allowed.");
}


// Ensure this function responds to the <domain>/mcp path
// This can be any path you want but you'll need to ensure the
// mcp server config you use/share matches this path.
export const config: Config = {
  path: ["/mcp"],
};
