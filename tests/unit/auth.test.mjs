import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../server/auth.js';

test('PBKDF2: verifica a senha certa e recusa a errada', async () => {
  const h = await hashPassword('uma senha longa e segura', 1000);
  assert.match(h, /^pbkdf2-sha256\$1000\$/);
  assert.equal(await verifyPassword('uma senha longa e segura', h), true);
  assert.equal(await verifyPassword('outra senha', h), false);
  assert.equal(await verifyPassword('x', 'lixo'), false);
});
