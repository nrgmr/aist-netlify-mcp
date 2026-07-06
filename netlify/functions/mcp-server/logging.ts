// Verbose transaction logging.
//
// Off by default. Set MCP_VERBOSE_LOGGING=true (or 1/yes) to log full
// per-transaction detail across the MCP, OAuth, and proxy functions. This is a
// diagnostic switch — leave it off in steady state. Errors are always logged
// regardless of this flag; debugLog()/verbose detail is the only thing it gates.
//
// Even in verbose mode, secrets are masked: bodies go through safeBodySummary()
// and tokens through maskToken(). We never log raw client secrets or full tokens.

export function isVerboseLogging(): boolean {
  try {
    // Tolerate stray whitespace and accidental surrounding quotes, e.g. '"true"'.
    const v = (process.env.MCP_VERBOSE_LOGGING ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  } catch {
    // process may be unavailable in some runtimes (e.g. edge); default to off.
    return false;
  }
}

// Logs only when verbose logging is enabled. Use for per-transaction detail that
// would otherwise be noise in steady state.
export function debugLog(label: string, details?: unknown): void {
  if (!isVerboseLogging()) return;
  if (details === undefined) {
    console.log(`[verbose] ${label}`);
  } else {
    console.log(`[verbose] ${label}`, details);
  }
}

// Mask a token/credential for logging: keep enough to correlate, never the whole
// value. Returns e.g. "eyJhbGci…b2c4 (len 312)".
export function maskToken(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.replace(/^Bearer\s+/i, '');
  if (trimmed.length <= 12) return `*** (len ${trimmed.length})`;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)} (len ${trimmed.length})`;
}

// Body fields that must never be logged in full. Everything else in a request
// body is considered safe to surface for debugging.
const SENSITIVE_BODY_FIELDS = new Set([
  'client_secret',
  'password',
  'code',
  'code_verifier',
  'refresh_token',
  'access_token',
  'id_token',
  'client_assertion',
  'registration_access_token',
]);

// Deep-redacts sensitive fields anywhere in a parsed JSON value. Depth matters:
// MCP tool-call bodies nest secrets (params.arguments.password), so a top-level
// sweep misses them. `code` is redacted only when it's a string — the string form
// is an OAuth authorization code, while the numeric form is a JSON-RPC error code
// that logs need to keep.
export function redactSensitive<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(redactSensitive) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) =>
        SENSITIVE_BODY_FIELDS.has(key) && (key !== 'code' || typeof entry === 'string')
          ? [key, '[redacted]']
          : [key, redactSensitive(entry)],
      ),
    ) as T;
  }
  return value;
}

// Produce a log-safe view of a request body: parses JSON or form-encoded
// payloads, redacts secrets at any depth, and surfaces the rest (including
// `scope`) so we can debug failures without leaking credentials.
export function safeBodySummary(body: string | null | undefined): Record<string, unknown> {
  if (!body) return { empty: true };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // not JSON — fall back to form-encoded (URLSearchParams never throws)
    parsed = Object.fromEntries(new URLSearchParams(body));
  }

  if (!parsed || typeof parsed !== 'object') {
    return { unparseable: true, length: body.length };
  }

  return redactSensitive(parsed as Record<string, unknown>);
}
