import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPasswordProtectionVerified,
  generateSitePassword,
  isPasswordProtected,
} from './password-protection-values.ts';

test('generateSitePassword uses five lowercase letters and exactly two digits', () => {
  for (let index = 0; index < 50; index += 1) {
    assert.match(generateSitePassword(), /^[a-z]{5}\d{2}$/);
  }
});

test('password protection is valid only when it covers all deploys', () => {
  assert.equal(isPasswordProtected({ has_password: true, password_context: 'all' }), true);
  assert.equal(isPasswordProtected({ has_password: true, password_context: 'non_production' }), false);
  assert.equal(isPasswordProtected({ has_password: false, password_context: 'all' }), false);
});

test('failed verification throws the fail-closed deployment error', () => {
  assert.throws(
    () => assertPasswordProtectionVerified({ has_password: false, password_context: null }),
    /Deployment was stopped before any files were uploaded/,
  );
});
