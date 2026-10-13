import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountBalance, dashboard, flows, budgetStatus, periodRange, nextOccurrence, reconcile, findDuplicates, deliveryStats, toCSV, addMonths } from '../../public/shared/finance.js';

const acc = (id, extra = {}) => ({ id, name: id, currency: 'EUR', is_reserve: 0, archived: 0, ...extra });
const tx = (o) => ({ id: Math.random().toString(36).slice(2), status: 'confirmada', currency: 'EUR', category: 'Outros', created_at: '2026-10-10T12:00:00Z', deleted_at: null, ...o });
const snap = (o) => ({ id: 's' + Math.random(), is_anchor: 1, status: 'a_confirmar', created_at: '2026-10-01T09:00:00Z', ...o });

test('saldo parte da âncora e soma só confirmadas posteriores', () => {
  const s = [snap({ account_id: 'a', amount_cents: 234567, date: '2026-10-01' })];
  const t = [
    tx({ account_id: 'a', kind: 'despesa', amount_cents: -2550, date: '2026-10-05' }),
    tx({ account_id: 'a', kind: 'despesa', amount_cents: -9999, date: '2026-09-30' }), // anterior à âncora: ignorada
    tx({ account_id: 'a', kind: 'receita', amount_cents: 5000, date: '2026-10-06', status: 'pendente' }),
    tx({ account_id: 'a', kind: 'despesa', amount_cents: -100, date: '2026-10-07', deleted_at: '2026-10-08' }),
  ];
  const r = accountBalance(acc('a'), s, t);
  assert.equal(r.balance, 234567 - 2550);
  assert.equal(r.pending, 5000);
});

test('mesma data da âncora: só conta o que foi registrado depois da fotografia', () => {
  const s = [snap({ account_id: 'a', amount_cents: 1000, date: '2026-10-01', created_at: '2026-10-01T10:00:00Z' })];
  const t = [tx({ account_id: 'a', kind: 'despesa', amount_cents: -100, date: '2026-10-01', created_at: '2026-10-01T09:00:00Z' }),
    tx({ account_id: 'a', kind: 'despesa', amount_cents: -200, date: '2026-10-01', created_at: '2026-10-01T11:00:00Z' })];
  assert.equal(accountBalance(acc('a'), s, t).balance, 800);
});

test('transferência não conta como receita nem despesa e preserva o total', () => {
  const t = [tx({ account_id: 'a', kind: 'transferencia', amount_cents: -20000, date: '2026-10-11', transfer_id: 'x' }),
    tx({ account_id: 'r', kind: 'transferencia', amount_cents: 20000, date: '2026-10-11', transfer_id: 'x' }),
    tx({ account_id: 'a', kind: 'despesa', amount_cents: -500, date: '2026-10-11' })];
  const f = flows(t, '2026-10-01', '2026-10-31', 'EUR');
  assert.deepEqual(f, { income: 0, expense: 500, result: -500 });
  const d = dashboard({ accounts: [acc('a'), acc('r', { is_reserve: 1 })], snapshots: [snap({ account_id: 'a', amount_cents: 100000, date: '2026-10-01' })], transactions: t }, '2026-10-12');
  assert.equal(d.byCurrency.EUR.total, 100000 - 500);
  assert.equal(d.byCurrency.EUR.reserve, 20000);
  assert.equal(d.byCurrency.EUR.available, 100000 - 500 - 20000);
});

test('patrimônio só soma moedas diferentes com taxa informada', () => {
  const data = { accounts: [acc('e'), acc('b', { currency: 'BRL' })], snapshots: [snap({ account_id: 'e', amount_cents: 10000, date: '2026-10-01' }), snap({ account_id: 'b', amount_cents: 5000, date: '2026-10-01' })], transactions: [],
    goals: [{ id: 'g', name: 'Meta', kind: 'patrimonio', target_cents: 10000000, currency: 'BRL', saved_cents: 0 }] };
  assert.equal(dashboard(data, '2026-10-12').netWorth.BRL, null);
  const d = dashboard({ ...data, settings: { eur_brl_milli: '6000' } }, '2026-10-12');
  assert.equal(d.netWorth.BRL, 60000 + 5000);
  assert.equal(d.goals[0].current, 65000);
  assert.equal(d.goals[0].pct, 0.7);
});

test('períodos de orçamento', () => {
  assert.deepEqual(periodRange('diario', '2026-10-13'), ['2026-10-13', '2026-10-13']);
  assert.deepEqual(periodRange('semanal', '2026-10-13'), ['2026-10-12', '2026-10-18']); // terça → seg a dom
  assert.deepEqual(periodRange('mensal', '2026-02-10'), ['2026-02-01', '2026-02-28']);
  const b = budgetStatus({ id: 'b', category: 'Mercado', period: 'semanal', limit_cents: 5000, currency: 'EUR' },
    [tx({ account_id: 'a', kind: 'despesa', amount_cents: -6000, category: 'Mercado', date: '2026-10-14' }), tx({ account_id: 'a', kind: 'despesa', amount_cents: -100, category: 'Lazer', date: '2026-10-14' })], '2026-10-13');
  assert.equal(b.spent, 6000); assert.equal(b.over, true);
});

test('recorrências avançam sem pular o fim do mês', () => {
  assert.equal(nextOccurrence('2026-01-31', 'mensal'), '2026-02-28');
  assert.equal(nextOccurrence('2026-10-13', 'semanal'), '2026-10-20');
  assert.equal(nextOccurrence('2024-02-29', 'anual'), '2025-02-28');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
});

test('conciliação calcula a diferença na data', () => {
  const a = acc('a'), s = [snap({ account_id: 'a', amount_cents: 100000, date: '2026-10-01' })];
  const t = [tx({ account_id: 'a', kind: 'despesa', amount_cents: -2550, date: '2026-10-05' }), tx({ account_id: 'a', kind: 'despesa', amount_cents: -1000, date: '2026-10-20' })];
  const r = reconcile(a, s, t, 97000, '2026-10-10');
  assert.equal(r.computed, 97450); assert.equal(r.difference, -450); assert.equal(r.matches, false);
});

test('duplicidade: mesmo valor e moeda dentro de 3 dias', () => {
  const t = [tx({ id: 'x', account_id: 'a', kind: 'despesa', amount_cents: -1299, date: '2026-10-10', description: 'Compra Lidl', merchant: 'Lidl' }),
    tx({ id: 'y', account_id: 'a', kind: 'despesa', amount_cents: -1299, date: '2026-10-20' })];
  const d = findDuplicates({ amount_cents: 1299, date: '2026-10-11', currency: 'EUR', merchant: 'LIDL Dublin' }, t);
  assert.equal(d.length, 1); assert.equal(d[0].id, 'x');
});

test('estatísticas do delivery', () => {
  const [s] = deliveryStats([{ currency: 'EUR', hours_x100: 400, km_x10: 500, orders: 10, gross_cents: 8000, tips_cents: 1000, costs_cents: 1000 }]);
  assert.equal(s.net, 8000); assert.equal(s.per_hour, 2000); assert.equal(s.per_km, 160);
});

test('CSV neutraliza fórmulas e escapa ponto e vírgula', () => {
  const csv = toCSV([{ a: '=HYPERLINK("x")', b: 'x;y', c: '-12,50' }], [['a', 'A'], ['b', 'B'], ['c', 'C']]);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`)); assert.ok(csv.includes('"x;y"')); assert.ok(csv.endsWith(';-12,50'));
});
