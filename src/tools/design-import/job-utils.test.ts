import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, encodeJob, decodeJob } from './job-utils.ts';

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

test('encodeJob/decodeJob round-trips siteId and deployId', () => {
  const jobId = encodeJob('site-123', 'deploy-456');
  assert.deepEqual(decodeJob(jobId), { siteId: 'site-123', deployId: 'deploy-456' });
});

test('decodeJob preserves a deployId that itself contains a colon', () => {
  const jobId = encodeJob('site-123', 'dep:loy:789');
  assert.deepEqual(decodeJob(jobId), { siteId: 'site-123', deployId: 'dep:loy:789' });
});

test('decodeJob throws on a malformed job_id', () => {
  const garbage = Buffer.from('no-separator-here').toString('base64url');
  assert.throws(() => decodeJob(garbage), /invalid job_id/);
});
