// Detects whether an MCP request comes from a Claude client (claude.ai connector
// infrastructure, Claude Desktop, Claude Code). Used to hide Claude-Design-only
// tools from every other agent's tools/list. The user-agent is checked on every
// request because the remote server is stateless: clientInfo only arrives on
// initialize, never on the tools/list or tools/call that follow.
const CLAUDE_CLIENT_PATTERN = /claude|anthropic/i;

export function isClaudeMCPClient(req: Request, body: any): boolean {
  const userAgent = req.headers.get('user-agent') || '';
  const clientName = body?.params?.clientInfo?.name || '';
  return CLAUDE_CLIENT_PATTERN.test(userAgent) || CLAUDE_CLIENT_PATTERN.test(clientName);
}
