import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, parseTask, parseMoneyCommand, confirmCode, applyTaskRules, executors } from '../../server/brain.js';

test('comandos do Telegram', () => {
  assert.deepEqual(parseCommand('/status'), { cmd: 'status', arg: '' });
  assert.deepEqual(parseCommand('/tarefa@WallBot Revisar PDF'), { cmd: 'tarefa', arg: 'Revisar PDF' });
  assert.equal(parseCommand('oi'), null);
});

test('tarefa: projeto e agente', () => {
  assert.deepEqual(parseTask('Revisar página #Ofertas @codex'), { title: 'Revisar página', project: 'ofertas', agent: 'codex' });
  assert.deepEqual(parseTask('Testar webhook @Claude'), { title: 'Testar webhook', project: 'geral', agent: 'claude_code' });
  assert.equal(parseTask('Pagar conta @fulano').agent, 'wallacy');
});

test('despesa: valor, descrição e conta', () => {
  assert.deepEqual(parseMoneyCommand('12,50 Mercado Lidl @revolut'), { amount_cents: 1250, description: 'Mercado Lidl', account: 'revolut' });
  assert.equal(parseMoneyCommand('abc Mercado').amount_cents, null);
  assert.equal(parseMoneyCommand('0 x').amount_cents, null);
});

test('código de confirmação muda quando o conteúdo muda', async () => {
  const a = await confirmCode('p1', 'hash-a'), b = await confirmCode('p1', 'hash-b');
  assert.match(a, /^[0-9A-F]{6}$/);
  assert.notEqual(a, b);
  assert.equal(a, await confirmCode('p1', 'hash-a'));
});

test('sem executor, tarefa de agente fica bloqueada; concluir exige evidência', () => {
  const t = applyTaskRules({ title: 'x', agent: 'codex', status: 'ready' }, {});
  assert.equal(t.status, 'blocked'); assert.match(t.blocked_reason, /Sem executor/);
  assert.equal(applyTaskRules({ title: 'x', agent: 'codex', status: 'ready' }, { BRAIN_EXECUTORS: 'codex' }).status, 'ready');
  assert.equal(applyTaskRules({ title: 'x', agent: 'wallacy', status: 'running' }, {}).status, 'running');
  assert.throws(() => applyTaskRules({ title: 'x', agent: 'wallacy', status: 'done', evidence: ' ' }, {}), /evidência/);
  assert.deepEqual(executors({ BRAIN_EXECUTORS: 'codex, wallacy, inventado' }), ['codex']);
});
