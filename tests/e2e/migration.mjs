// Testa as migrações D1 sobre um banco que JÁ tem dados da v1.0: aplica 0001, grava dados,
// aplica as migrações seguintes e confere que nada se perdeu.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = new URL('../../', import.meta.url).pathname;
const wrangler = join(root, 'node_modules/.bin/wrangler');
const dir = mkdtempSync(join(tmpdir(), 'wf-mig-')), mig = join(dir, 'm');
mkdirSync(mig);
writeFileSync(join(dir, 'w.toml'), `name="t"\ncompatibility_date="2025-09-01"\n[[d1_databases]]\nbinding="DB"\ndatabase_name="t"\ndatabase_id="00000000-0000-0000-0000-000000000000"\nmigrations_dir="${mig}"\n`);
const run = (...a) => execFileSync(wrangler, [...a, '--local', '--persist-to', join(dir, 'p'), '-c', join(dir, 'w.toml')], { env: { ...process.env, CI: '1' }, encoding: 'utf8' });
const files = readdirSync(join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort();
copyFileSync(join(root, 'migrations', files[0]), join(mig, files[0]));
run('d1', 'migrations', 'apply', 't');
run('d1', 'execute', 't', '--command', `INSERT INTO fin_accounts (id,name,currency,kind,created_at,updated_at) VALUES ('a1','Conta','EUR','banco','t','t');
  INSERT INTO fin_transactions (id,account_id,kind,amount_cents,currency,date,description,status,created_at,updated_at) VALUES ('t1','a1','despesa',-100,'EUR','2026-01-01','x','confirmada','t','t');
  INSERT INTO os_items (id,module,title,created_at,updated_at,version) VALUES ('o1','diario','Antigo','t','t',3);
  INSERT INTO fin_audit (id,at,action,entity,entity_id) VALUES ('au1','t','criar','conta','a1');`);
for (const f of files.slice(1)) copyFileSync(join(root, 'migrations', f), join(mig, f));
run('d1', 'migrations', 'apply', 't');
const raw = (run('d1', 'execute', 't', '--json', '--command', `SELECT (SELECT count(*) FROM fin_transactions) tx, (SELECT amount_cents FROM fin_transactions) amt,
  (SELECT title || '|' || version || '|' || archived FROM os_items) os, (SELECT count(*) FROM fin_audit) audit, (SELECT count(*) FROM fin_reserves) reserves, (SELECT count(*) FROM brain_tasks) + (SELECT count(*) FROM brain_memory) brain`));
const out = JSON.parse(raw.slice(raw.indexOf('[')));
assert.deepEqual(out[0].results[0], { tx: 1, amt: -100, os: 'Antigo|3|0', audit: 1, reserves: 0, brain: 0 });
console.log(`  ✔ Migrações ${files.join(', ')} preservam os dados existentes`);
