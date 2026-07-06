import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitive, safeBodySummary } from './logging.ts';

test('redactSensitive masks secrets nested in tool-call arguments', () => {
  const params = {
    name: 'import-claude-design-from-url',
    arguments: { url: 'https://example.com', password: 'hunter2', title: 'ok' },
  };
  const safe = redactSensitive(params);
  assert.equal(safe.arguments.password, '[redacted]');
  assert.equal(safe.arguments.url, 'https://example.com');
  // the original is untouched
  assert.equal(params.arguments.password, 'hunter2');
});

test('redactSensitive keeps numeric JSON-RPC error codes but masks string OAuth codes', () => {
  assert.equal(redactSensitive({ error: { code: -32603 } }).error.code, -32603);
  assert.equal(redactSensitive({ code: 'authz-code-abc' }).code, '[redacted]');
});

test('redactSensitive walks arrays and deep objects', () => {
  const out = redactSensitive([{ a: { refresh_token: 'r1' } }, { access_token: 't2' }]) as any[];
  assert.equal(out[0].a.refresh_token, '[redacted]');
  assert.equal(out[1].access_token, '[redacted]');
});

test('safeBodySummary redacts at depth for JSON-RPC bodies', () => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: 'x', arguments: { password: 'hunter2' } },
  });
  const safe = safeBodySummary(body) as any;
  assert.equal(safe.params.arguments.password, '[redacted]');
});
