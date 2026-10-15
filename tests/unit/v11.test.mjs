import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboard, investmentPosition, suggestAccount } from '../../public/shared/finance.js';
import { parseCSV, detectColumns, toTransactions, parseSignedAmount } from '../../public/shared/statement.js';
import { answer, detectIntent } from '../../public/shared/assistant-rules.js';

const acc = (id, extra = {}) => ({ id, name: id, currency: 'EUR', is_reserve: 0, archived: 0, exclude_from_budget: 0, ...extra });
const snap = (account_id, amount_cents) => ({ id: 's' + account_id, account_id, amount_cents, date: '2026-10-01', is_anchor: 1, status: 'a_confirmar', created_at: '2026-10-01T00:00:00Z' });
const base = () => ({
  accounts: [acc('AstroPay EUR'), acc('Revolut EUR'), acc('AstroPay BRL', { currency: 'BRL' }), acc('Moedas ônibus', { kind: 'especie', exclude_from_budget: 1 })],
  snapshots: [snap('AstroPay EUR', 50000), snap('Revolut EUR', 0), snap('AstroPay BRL', 0)],
  transactions: [], recurring: [], shifts: [], goals: [], investments: [], investmentOps: [], planned: [],
  reserves: [{ id: 'r', name: 'Moradia', account_id: 'AstroPay EUR', target_cents: 60000, allocated_cents: 45000, archived: 0 }],
  budgets: [{ id: 'b', name: 'Dia', category: null, period: 'diario', limit_cents: 1000, currency: 'EUR', active: 1 }],
  settings: {},
});

test('reserva dentro da conta reduz o disponível sem virar despesa nem duplicar saldo', () => {
  const d = dashboard(base(), '2026-10-13');
  assert.equal(d.byCurrency.EUR.total, 50000);
  assert.equal(d.byCurrency.EUR.reserve, 45000);
  assert.equal(d.byCurrency.EUR.available, 5000);
  assert.equal(d.byCurrency.EUR.month.expense, 0);
  assert.equal(d.byCurrency.BRL.total, 0, 'contas em moedas diferentes não se somam');
  assert.equal(d.reserves[0].deficit, 15000);
});

test('orçamento diário limitado ao dinheiro livre de reservas', () => {
  const data = base(); data.reserves[0].allocated_cents = 49500;
  const [b] = dashboard(data, '2026-10-13').budgets;
  assert.equal(b.remaining, 1000); assert.equal(b.usable, 500); assert.equal(b.limitedByAvailability, true);
});

test('posição de investimento por operações, sem lançamentos', () => {
  const p = investmentPosition({ id: 'i', currency: 'EUR', invested_cents: 0, current_cents: 13000 },
    [{ investment_id: 'i', type: 'compra', total_cents: 10000, quantity_micro: 2e6 }, { investment_id: 'i', type: 'compra', total_cents: 5000, quantity_micro: 1e6 },
      { investment_id: 'i', type: 'venda', total_cents: 4000, quantity_micro: 1e6 }, { investment_id: 'i', type: 'rendimento', total_cents: 200 }, { investment_id: 'i', type: 'taxa', total_cents: 100 }]);
  assert.deepEqual([p.invested, p.quantity_micro, p.value, p.result], [11000, 2e6, 13000, 2100]);
});

test('sugere a conta de origem pelo nome no comprovante e pela moeda', () => {
  const accounts = base().accounts;
  assert.equal(suggestAccount({ currency: 'EUR', text: 'Revolut · Pagamento enviado' }, accounts).id, 'Revolut EUR');
  assert.equal(suggestAccount({ currency: 'BRL', text: 'Pix' }, accounts).id, 'AstroPay BRL');
});

test('CSV Revolut: sinal, taxa, pendentes e linhas revertidas', () => {
  const csv = 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n'
    + 'CARD_PAYMENT,Current,2026-10-01 10:00:00,2026-10-02 09:00:00,Lidl,-12.50,0.00,EUR,COMPLETED,100\n'
    + 'TOPUP,Current,2026-10-03 10:00:00,2026-10-03 10:00:00,"Top-up, AstroPay",50.00,0.50,EUR,COMPLETED,150\n'
    + 'CARD_PAYMENT,Current,2026-10-04 10:00:00,,Café,-3.20,0,EUR,PENDING,\n'
    + 'CARD_PAYMENT,Current,2026-10-05 10:00:00,2026-10-05 10:00:00,Erro,-9.99,0,EUR,REVERTED,\n';
  const p = parseCSV(csv), cols = detectColumns(p.headers);
  assert.equal(cols.preset, 'Revolut');
  const { rows, errors } = toTransactions(p, cols, 'EUR');
  assert.deepEqual(rows.map(r => [r.date, r.description, r.amount_cents, r.pending]), [['2026-10-02', 'Lidl', -1250, false], ['2026-10-03', 'Top-up, AstroPay', 4950, false], ['2026-10-04', 'Café', -320, true]]);
  assert.equal(errors.length, 1);
});

test('CSV genérico pt-BR com débito/crédito e ponto e vírgula', () => {
  const p = parseCSV('Data;Histórico;Débito;Crédito\n05/10/2026;Mercado;1.234,56;\n06/10/2026;Salário;;2.000,00\n');
  const { rows } = toTransactions(p, detectColumns(p.headers), 'BRL');
  assert.deepEqual(rows.map(r => [r.date, r.amount_cents, r.currency]), [['2026-10-05', -123456, 'BRL'], ['2026-10-06', 200000, 'BRL']]);
  assert.equal(parseSignedAmount('(12,50)'), -1250); assert.equal(parseSignedAmount('12,50-'), -1250);
});

test('assistente responde as perguntas principais pelas regras', () => {
  const fin = base();
  const os = [{ module: 'checklist', title: 'Estudar inglês', done: 0, archived: 0, date: '2026-10-13' }, { module: 'checklist', title: 'Feito', done: 1, archived: 0, date: '2026-10-13' }];
  const ctx = { fin, os, date: '2026-10-13' };
  assert.match(answer('Quanto tenho disponível hoje?', ctx).texto, /€\s50,00 livres/);
  assert.match(answer('Quanto ainda falta para completar minha reserva?', ctx).texto, /Faltam €\s150,00/);
  assert.match(answer('Quais tarefas ainda tenho hoje?', ctx).texto, /1 tarefa\(s\) em aberto: Estudar inglês/);
  assert.equal(detectIntent('Quais contas vencem nesta semana?'), 'vencimentos');
  assert.equal(detectIntent('Quanto ganhei trabalhando com delivery?'), 'delivery');
  assert.equal(detectIntent('Quanto economizei neste mês?'), 'economia');
  assert.equal(detectIntent('Qual é o progresso das minhas metas?'), 'metas');
  assert.equal(answer('qual a capital da França?', ctx), null);
});

test('extrato: transferências entre contas são marcadas para revisão', () => {
  const csv = 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n'
    + 'CARD_PAYMENT,Current,2026-10-11 10:00:00,2026-10-11 10:05:00,Padaria,-3.10,0.00,EUR,COMPLETED,1\n'
    + 'TOPUP,Current,2026-10-11 11:00:00,2026-10-11 11:00:00,Top-Up by *1234,50.00,0.00,EUR,COMPLETED,1\n'
    + 'EXCHANGE,Current,2026-10-11 12:00:00,2026-10-11 12:00:00,Exchanged to BRL,-20.00,0.00,EUR,COMPLETED,1\n';
  const p = parseCSV(csv), cols = detectColumns(p.headers);
  const { rows } = toTransactions(p, cols, 'EUR');
  assert.deepEqual(rows.map(r => r.transfer), [false, true, true]);
  const generic = parseCSV('Data;Descrição;Valor\n11/10/2026;Transferência entre contas;-10,00\n11/10/2026;Mercado;-5,00\n');
  assert.deepEqual(toTransactions(generic, detectColumns(generic.headers), 'EUR').rows.map(r => r.transfer), [true, false]);
});
