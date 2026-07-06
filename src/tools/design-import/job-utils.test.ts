import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, encodeJob, decodeJob, projectMarker, importSiteName, fallbackImportSiteName, isBlockedFetchHost, isPrivateAddress } from './job-utils.ts';

test('slugify returns undefined for missing or empty titles', () => {
  assert.equal(slugify(undefined), undefined);
  assert.equal(slugify(''), undefined);
  assert.equal(slugify('!!!'), undefined);
});

test('slugify lowercases, hyphenates, and trims to a valid site name', () => {
  assert.equal(slugify('My Cool Design'), 'my-cool-design');
  assert.equal(slugify('  Spaces & Symbols!! '), 'spaces-symbols');
  assert.equal(slugify('Trailing---'), 'trailing');
});

test('slugify caps length at 40 chars with no trailing hyphen', () => {
  const out = slugify('a'.repeat(60))!;
  assert.ok(out.length <= 40);
  assert.doesNotMatch(out, /-$/);
});

test('projectMarker is deterministic, url-safe, and does not expose the project id', () => {
  const marker = projectMarker('p1782841610658559');
  assert.equal(marker, projectMarker('p1782841610658559'));
  assert.match(marker, /^cd-[0-9a-f]{10}$/);
  assert.ok(!marker.includes('1782841610658559'));
  assert.notEqual(marker, projectMarker('p999'));
});

test('importSiteName combines title slug with the project marker', () => {
  assert.equal(importSiteName('My Cool Design'), 'my-cool-design');
  assert.equal(importSiteName('My Cool Design', 'p123'), `my-cool-design-${projectMarker('p123')}`);
  assert.equal(importSiteName(undefined, 'p123'), projectMarker('p123'));
  assert.equal(importSiteName(undefined, undefined), undefined);
});

test('importSiteName stays within the 63-char subdomain limit', () => {
  const name = importSiteName('x'.repeat(100), 'p123')!;
  assert.ok(name.length <= 63, `name is ${name.length} chars`);
});

test('fallbackImportSiteName keeps the marker so re-send lookups still match', () => {
  const name = fallbackImportSiteName('p123', 'a1b2c3');
  assert.equal(name, `${projectMarker('p123')}-a1b2c3`);
  assert.ok(name.includes(projectMarker('p123')));
  assert.notEqual(name, fallbackImportSiteName('p123', 'z9y8x7'));
});

test('encodeJob/decodeJob round-trips siteId and deployId', () => {
  const jobId = encodeJob('site-123', 'deploy-456');
  assert.deepEqual(decodeJob(jobId), { siteId: 'site-123', deployId: 'deploy-456' });
});

test('decodeJob throws on a malformed job_id', () => {
  const garbage = Buffer.from('no-separator-here').toString('base64url');
  assert.throws(() => decodeJob(garbage), /invalid job_id/);
});

test('decodeJob rejects ids that could traverse the deploy API path', () => {
  // deployId is interpolated into GET /api/v1/deploys/<deployId>; "../../user"
  // would resolve to a different authenticated endpoint.
  const traversal = encodeJob('site-123', '../../user');
  assert.throws(() => decodeJob(traversal), /invalid job_id/);
  const slashed = encodeJob('site-123', 'a/b');
  assert.throws(() => decodeJob(slashed), /invalid job_id/);
});

test('isBlockedFetchHost blocks internal destinations, allows public ones', () => {
  for (const h of ['localhost', 'app.local', 'svc.internal', '127.0.0.1', '10.0.0.5',
    '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', 'fd00::1']) {
    assert.ok(isBlockedFetchHost(h), `${h} should be blocked`);
  }
  for (const h of ['example.com', 'files.claude.ai', '8.8.8.8', '172.15.0.1', '172.32.0.1']) {
    assert.ok(!isBlockedFetchHost(h), `${h} should be allowed`);
  }
});

test('isPrivateAddress classifies resolved IPs, including hex IPv4-mapped IPv6', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.31.255.255', '192.168.0.1',
    '::1', '::', 'fe80::1', 'fea0::1', 'febf::1', 'fc00::1', 'fd00::1',
    // IPv4-mapped in the hex form new URL() actually produces:
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:0a00:0001', '::ffff:127.0.0.1',
    'fe80::1%eth0']) {
    assert.ok(isPrivateAddress(ip), `${ip} should be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1',
    '2606:4700::1', '2001:db8::1', '::ffff:8.8.8.8', '::ffff:0808:0808']) {
    assert.ok(!isPrivateAddress(ip), `${ip} should be public`);
  }
});
