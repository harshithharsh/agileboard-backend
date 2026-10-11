import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_SECRET = 'test-secret-for-unit-tests';
const { encrypt, decrypt } = await import('../src/lib/crypto.js');

test('encrypt/decrypt round-trips and never stores the plain text', () => {
  const secret = 'ATATT-example-token-1234';
  const stored = encrypt(secret);
  assert.ok(!stored.includes(secret));
  assert.equal(decrypt(stored), secret);
  assert.notEqual(encrypt(secret), stored, 'a fresh random IV each time');
});

test('tampered data is rejected', () => {
  const stored = Buffer.from(encrypt('abc'), 'base64');
  stored[stored.length - 1] ^= 1;
  assert.throws(() => decrypt(stored.toString('base64')));
});
