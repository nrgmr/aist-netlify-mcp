import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, encodeJob, decodeJob, projectMarker, importSiteName, fallbackImportSiteName } from './job-utils.ts';

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

