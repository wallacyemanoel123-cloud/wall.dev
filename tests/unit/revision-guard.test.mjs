import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { revisionCheck, isRevisionConflict } from '../../server/store.js';

// Mesmo SQL usado no D1: dentro de uma transação, falha (e desfaz tudo) se outra gravação mudou a revisão.
test('verificação de revisão desfaz a gravação quando outro aparelho gravou antes', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sys_revision (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL); INSERT INTO sys_revision VALUES (1, 5); CREATE TABLE t (x INTEGER);');
  let sql, args;
  const fake = { prepare: s => ({ bind: (...a) => { sql = s; args = a; return {}; } }) };
  const run = rev => {
    revisionCheck(fake, rev);
    db.exec('BEGIN');
    try { db.prepare('INSERT INTO t VALUES (1)').run(); db.prepare(sql).run(...args); db.exec('UPDATE sys_revision SET value = value + 1'); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  run(5);
  assert.equal(db.prepare('SELECT count(*) n FROM t').get().n, 1);
  assert.throws(() => run(5), e => isRevisionConflict(e));
  assert.equal(db.prepare('SELECT count(*) n FROM t').get().n, 1, 'gravação desfeita');
  assert.equal(db.prepare('SELECT value FROM sys_revision').get().value, 6);
});

// Mesmo SQL do /confirmar: se a proposta já não estava aguardando, a gravação inteira é desfeita.
test('confirmar a mesma proposta duas vezes não grava o segundo lançamento', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE sys_revision (id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO sys_revision VALUES (1, 1); CREATE TABLE p (id TEXT, status TEXT); INSERT INTO p VALUES ('x', 'aguardando'); CREATE TABLE tx (id TEXT);");
  const confirm = () => {
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE p SET status = 'confirmada' WHERE id = 'x' AND status = 'aguardando'").run();
      db.prepare('INSERT INTO sys_revision (id, value) SELECT 1, 0 WHERE changes() = 0').run();
      db.prepare("INSERT INTO tx VALUES ('t')").run();
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  confirm();
  assert.throws(confirm, e => isRevisionConflict(e));
  assert.equal(db.prepare('SELECT count(*) n FROM tx').get().n, 1);
});
