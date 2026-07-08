// Detects whether an MCP request comes from a Claude client that should see the
// Claude-Design import tool. Used to keep the tool out of every non-Claude agent's
// tools/list. The user-agent is checked on every request because the remote server
// is stateless: clientInfo only arrives on initialize, never on the tools/list or
// tools/call that follow.
//
// Claude Code is excluded: it is a coding CLI where an "import a design" tool is
// out of place, and it is the one Claude surface we can tell apart by user-agent
// (claude-code/<version>). claude.ai chat and Claude Design share the Claude-User
// agent, so they cannot be separated here — both still match.
const CLAUDE_CLIENT_PATTERN = /claude|anthropic/i;
const CLAUDE_CODE_PATTERN = /claude-code/i;

export function isClaudeMCPClient(req: Request, body: any): boolean {
  const userAgent = req.headers.get('user-agent') || '';
  const clientName = body?.params?.clientInfo?.name || '';
  if (CLAUDE_CODE_PATTERN.test(userAgent) || CLAUDE_CODE_PATTERN.test(clientName)) {
    return false;
  }
  return CLAUDE_CLIENT_PATTERN.test(userAgent) || CLAUDE_CLIENT_PATTERN.test(clientName);
}
