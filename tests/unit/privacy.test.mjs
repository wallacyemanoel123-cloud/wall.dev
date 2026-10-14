// Garante que nenhum dado financeiro pessoal foi parar no código público.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Valores de referência do titular (escritos em partes para não aparecerem literalmente aqui).
const FORBIDDEN = [['1158', '59'], ['1.158', ',59'], ['1158', '.59'], ['1158', '59', ''], ['41', ',41'], ['41', '.41'], ['4141', '']].map(p => p.join(''));
const SECRETS = [/pbkdf2-sha256\$\d+\$[A-Za-z0-9+/]{20,}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /CLOUDFLARE_API_TOKEN\s*=\s*\S{20,}/];

test('nenhum saldo pessoal nem segredo nos arquivos versionados', () => {
  const root = new URL('../../', import.meta.url).pathname;
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter(f => f && !f.endsWith('.png') && f !== 'package-lock.json' && !f.endsWith('privacy.test.mjs'));
  for (const f of files) {
    const text = readFileSync(root + f, 'utf8');
    for (const v of FORBIDDEN) assert.ok(!text.includes(v), `${f} contém valor pessoal (${v})`);
    for (const re of SECRETS) assert.ok(!re.test(text), `${f} parece conter um segredo`);
  }
});
