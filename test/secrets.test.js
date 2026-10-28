import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from '../src/config/secrets.js';

test('saved tokens are encrypted and only read back with the same SECRETS_KEY', () => {
  process.env.SECRETS_KEY = 'test-key-one';
  const a = encryptSecret('ATATT-secret-token');
  const b = encryptSecret('ATATT-secret-token');
  assert.notEqual(a, b, 'random IV each time');
  assert.ok(!a.includes('secret'), 'no plain text stored');
  assert.equal(decryptSecret(a), 'ATATT-secret-token');

  process.env.SECRETS_KEY = 'test-key-two';
  assert.equal(decryptSecret(a), null, 'a different key cannot read it');
  assert.equal(decryptSecret('garbage'), null);

  delete process.env.SECRETS_KEY;
  assert.throws(() => encryptSecret('x'), /SECRETS_KEY/);
  assert.equal(decryptSecret(b), null);
});
