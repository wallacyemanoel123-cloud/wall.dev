// Regras financeiras puras (sem banco, sem DOM): usadas pelo servidor e pelo navegador.
import { convert } from './money.js';

export const TIMEZONE = 'Europe/Dublin';
export const CATEGORIES = ['Moradia', 'Alimentação', 'Mercado', 'Transporte', 'Combustível', 'Delivery', 'Contas', 'Assinaturas',
  'Saúde', 'Educação', 'Lazer', 'Roupas', 'Compras', 'Impostos', 'Taxas', 'Salário', 'Freelance', 'Investimentos', 'Outros'];

export function today(tz = TIMEZONE, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const utc = s => new Date(s + 'T00:00:00Z');
const iso = d => d.toISOString().slice(0, 10);
export function addDays(s, n) { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
export function addMonths(s, n) {
  const d = utc(s), day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return iso(t);
}

export function nextOccurrence(date, frequency) {
  if (frequency === 'semanal') return addDays(date, 7);
  if (frequency === 'mensal') return addMonths(date, 1);
  if (frequency === 'anual') return addMonths(date, 12);
  throw new Error('Frequência inválida.');
}

// Intervalo [início, fim] do período que contém a data. Semana começa na segunda.
export function periodRange(period, date) {
  if (period === 'diario') return [date, date];
  if (period === 'semanal') {
    const dow = (utc(date).getUTCDay() + 6) % 7;
    const start = addDays(date, -dow);
    return [start, addDays(start, 6)];
  }
  if (period === 'mensal') {
    const start = date.slice(0, 8) + '01';
    return [start, addDays(addMonths(start, 1), -1)];
  }
  throw new Error('Período inválido.');
}

const live = t => !t.deleted_at;
const confirmed = t => live(t) && t.status === 'confirmada';

// Âncora: fotografia de saldo marcada como ponto de partida, a mais recente.
export function anchorFor(accountId, snapshots) {
  return snapshots.filter(s => s.account_id === accountId && s.is_anchor)
    .sort((a, b) => (a.date + a.created_at).localeCompare(b.date + b.created_at)).at(-1) || null;
}

// Transação entra no saldo calculado se for posterior à âncora
// (mesma data: só se foi registrada depois da fotografia).
export function afterAnchor(t, anchor) {
  if (!anchor) return true;
  return t.date > anchor.date || (t.date === anchor.date && t.created_at > anchor.created_at);
}

export function accountBalance(account, snapshots, txs) {
  const anchor = anchorFor(account.id, snapshots);
  let balance = anchor ? anchor.amount_cents : 0, pending = 0;
  for (const t of txs) {
    if (t.account_id !== account.id || !live(t) || !afterAnchor(t, anchor)) continue;
    if (t.status === 'confirmada') balance += t.amount_cents; else pending += t.amount_cents;
  }
  return { balance, pending, anchor };
}

// Receitas/despesas reais: transferências e ajustes NUNCA entram aqui.
export function flows(txs, from, to, currency) {
  let income = 0, expense = 0;
  for (const t of txs) {
    if (!confirmed(t) || t.date < from || t.date > to || (currency && t.currency !== currency)) continue;
    if (t.kind === 'receita') income += t.amount_cents;
    else if (t.kind === 'despesa') expense += -t.amount_cents;
  }
  return { income, expense, result: income - expense };
}

export function dashboard({ accounts, snapshots, transactions, investments = [], goals = [], budgets = [], reserves = [], planned = [], investmentOps = [], settings = {} }, date = today()) {
  const rate = Number(settings.eur_brl_milli) || null;
  const list = accounts.filter(a => !a.archived).map(a => ({ ...a, ...accountBalance(a, snapshots, transactions) }));
  const activeReserves = reserves.filter(r => !r.archived).map(r => {
    const acc = list.find(a => a.id === r.account_id);
    return { ...r, currency: acc?.currency || 'EUR', account_name: acc?.name || 'Conta arquivada', deficit: Math.max(0, r.target_cents - r.allocated_cents),
      overAllocated: acc ? r.allocated_cents > Math.max(0, acc.balance) : false };
  });
  const byCurrency = {};
  const positions = investments.map(i => investmentPosition(i, investmentOps));
  for (const c of ['EUR', 'BRL']) {
    const acc = list.filter(a => a.currency === c);
    const inv = positions.filter(i => i.currency === c).reduce((s, i) => s + i.value, 0);
    const total = acc.reduce((s, a) => s + a.balance, 0);
    const reserveAccounts = acc.filter(a => a.is_reserve).reduce((s, a) => s + a.balance, 0);
    const allocated = activeReserves.filter(r => r.currency === c && list.some(a => a.id === r.account_id && !a.is_reserve)).reduce((s, r) => s + r.allocated_cents, 0);
    const excluded = acc.filter(a => a.exclude_from_budget && !a.is_reserve).reduce((s, a) => s + a.balance, 0);
    const [ms, me] = periodRange('mensal', date);
    const plannedSoon = planned.filter(p => p.status === 'planejada' && p.currency === c && p.kind === 'despesa' && (!p.due_date || p.due_date <= addDays(date, 30)))
      .reduce((s, p) => s + p.amount_cents, 0);
    // Disponível = saldo das contas − contas-reserva − valores reservados dentro das contas − contas fora do orçamento.
    byCurrency[c] = { total, reserve: reserveAccounts + allocated, excluded, available: total - reserveAccounts - allocated - excluded,
      planned30: plannedSoon, investments: inv, net_worth: total + inv, month: flows(transactions, ms, me, c) };
  }
  const netWorth = to => {
    let sum = 0;
    for (const c of ['EUR', 'BRL']) { const v = convert(byCurrency[c].net_worth, c, to, rate); if (v === null) return null; sum += v; }
    return sum;
  };
  const budgetList = budgets.filter(b => b.active).map(b => {
    const st = budgetStatus(b, transactions, date);
    const avail = byCurrency[b.currency]?.available ?? 0;
    // O orçamento só pode ser gasto se houver dinheiro livre de reservas.
    return { ...st, usable: Math.max(0, Math.min(st.remaining, avail)), limitedByAvailability: st.remaining > avail };
  });
  return {
    date, rate, accounts: list, byCurrency, reserves: activeReserves, positions,
    netWorth: { EUR: netWorth('EUR'), BRL: netWorth('BRL') },
    pendingCount: transactions.filter(t => live(t) && t.status === 'pendente').length,
    budgets: budgetList,
    goals: goals.map(g => goalProgress(g, { accounts: list, byCurrency, rate, netWorth, reserves: activeReserves })),
  };
}

// Posição de um investimento a partir das operações registradas manualmente.
export function investmentPosition(inv, ops = []) {
  const mine = ops.filter(o => o.investment_id === inv.id);
  let invested = inv.invested_cents || 0, qty = 0, income = 0, fees = 0;
  for (const o of mine) {
    if (o.type === 'compra' || o.type === 'aporte') { invested += o.total_cents; qty += o.quantity_micro; }
    else if (o.type === 'venda' || o.type === 'resgate') { invested -= o.total_cents; qty -= o.quantity_micro; }
    else if (o.type === 'rendimento') income += o.total_cents;
    else if (o.type === 'taxa') fees += o.total_cents;
  }
  const value = inv.current_cents ?? invested;
  return { ...inv, invested, quantity_micro: qty, income, fees, value, result: value - invested + income - fees, ops: mine.length };
}

// Sugere a conta de origem de um comprovante (nunca decide sozinho: o titular confirma).
export function suggestAccount({ currency, merchant, text = '' }, accounts, txs = []) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '');
  const t = norm(text), m = norm(merchant);
  const scored = accounts.filter(a => !a.archived).map(a => {
    let score = 0; const why = [];
    if (currency && a.currency === currency) { score += 2; why.push('mesma moeda'); }
    for (const word of [a.name, a.institution].map(norm).flatMap(x => x.split(' ')).filter(w => w.length >= 4)) {
      if (t.includes(word)) { score += 5; why.push(`“${word}” aparece no comprovante`); break; }
    }
    if (m) {
      const uses = txs.filter(x => !x.deleted_at && x.account_id === a.id && norm(x.merchant || x.description).includes(m)).length;
      if (uses) { score += Math.min(3, uses); why.push(`${uses} lançamento(s) anteriores neste estabelecimento`); }
    }
    if (a.is_reserve || a.exclude_from_budget) score -= 3;
    return { id: a.id, name: a.name, score, why };
  }).sort((x, y) => y.score - x.score);
  return scored[0] && scored[0].score > 0 ? scored[0] : null;
}

export function budgetStatus(budget, txs, date) {
  const [from, to] = periodRange(budget.period, date);
  let spent = 0, pending = 0;
  for (const t of txs) {
    if (!live(t) || t.kind !== 'despesa' || t.currency !== budget.currency || t.date < from || t.date > to) continue;
    if (budget.category && t.category !== budget.category) continue;
    if (t.status === 'confirmada') spent += -t.amount_cents; else pending += -t.amount_cents;
  }
  return { ...budget, from, to, spent, pending, remaining: budget.limit_cents - spent, over: spent > budget.limit_cents };
}

export function goalProgress(goal, { accounts, byCurrency, rate, netWorth, reserves = [] }) {
  let current = goal.saved_cents || 0, note = 'Valor informado manualmente';
  if (goal.kind === 'patrimonio') { current = netWorth(goal.currency); note = current === null ? 'Informe a taxa EUR→BRL para somar moedas diferentes' : 'Patrimônio calculado (contas + investimentos)'; }
  else if (goal.kind === 'reserva') {
    const inAccounts = convertSum(accounts.filter(a => a.is_reserve), goal.currency, rate);
    let inReserves = 0;
    for (const r of reserves) { const v = convert(r.allocated_cents, r.currency, goal.currency, rate); if (v === null) { inReserves = null; break; } inReserves += v; }
    current = inAccounts === null || inReserves === null ? null : inAccounts + inReserves;
    note = 'Contas de reserva + valores reservados';
  }
  else if (goal.kind === 'conta' && goal.account_id) { const a = accounts.find(x => x.id === goal.account_id); current = a ? convert(a.balance, a.currency, goal.currency, rate) : null; note = a ? 'Saldo da conta ' + a.name : 'Conta não encontrada'; }
  const pct = current === null || !goal.target_cents ? null : Math.max(0, Math.min(100, Math.round(current * 1000 / goal.target_cents) / 10));
  return { ...goal, current, pct, note, missing: current === null ? null : Math.max(0, goal.target_cents - current) };
}

function convertSum(accounts, to, rate) {
  let s = 0;
  for (const a of accounts) { const v = convert(a.balance, a.currency, to, rate); if (v === null) return null; s += v; }
  return s;
}

// Relatório mensal por moeda: totais, categorias e série diária.
export function monthlyReport(txs, month, currency) {
  const from = month + '-01', to = periodRange('mensal', from)[1];
  const totals = flows(txs, from, to, currency);
  const cats = new Map(), days = new Map();
  for (const t of txs) {
    if (!confirmed(t) || t.currency !== currency || t.date < from || t.date > to || !['receita', 'despesa'].includes(t.kind)) continue;
    if (t.kind === 'despesa') cats.set(t.category, (cats.get(t.category) || 0) - t.amount_cents);
    const d = days.get(t.date) || { date: t.date, income: 0, expense: 0 };
    if (t.kind === 'receita') d.income += t.amount_cents; else d.expense -= t.amount_cents;
    days.set(t.date, d);
  }
  return {
    month, currency, ...totals,
    categories: [...cats].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function lastMonths(date, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(date.slice(0, 8) + '01', -i).slice(0, 7));
  return out;
}

// Conciliação: compara saldo informado pelo banco com o saldo calculado na mesma data.
export function reconcile(account, snapshots, txs, reportedCents, date) {
  const anchor = anchorFor(account.id, snapshots);
  let computed = anchor && anchor.date <= date ? anchor.amount_cents : 0;
  for (const t of txs) {
    if (t.account_id !== account.id || !confirmed(t) || t.date > date) continue;
    if (anchor && (anchor.date > date || !afterAnchor(t, anchor))) continue;
    computed += t.amount_cents;
  }
  const pending = txs.filter(t => t.account_id === account.id && live(t) && t.status === 'pendente' && t.date <= date)
    .reduce((s, t) => s + t.amount_cents, 0);
  return { account_id: account.id, date, reported: reportedCents, computed, difference: reportedCents - computed, pending, matches: reportedCents === computed };
}

// Possíveis duplicidades para um lançamento candidato (ex.: recibo lido).
export function findDuplicates(candidate, txs, windowDays = 3) {
  const abs = Math.abs(candidate.amount_cents);
  const from = addDays(candidate.date, -windowDays), to = addDays(candidate.date, windowDays);
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
  const m = norm(candidate.merchant);
  return txs.filter(t => live(t) && t.id !== candidate.id && t.currency === candidate.currency && Math.abs(t.amount_cents) === abs && t.date >= from && t.date <= to)
    .map(t => {
      const other = norm(t.merchant || t.description);
      const sameMerchant = m && other && (other.includes(m) || m.includes(other));
      return { id: t.id, date: t.date, description: t.description, amount_cents: t.amount_cents, account_id: t.account_id, score: (t.date === candidate.date ? 2 : 1) + (sameMerchant ? 2 : 0) };
    }).sort((a, b) => b.score - a.score);
}

export function deliveryStats(shifts) {
  const by = {};
  for (const s of shifts) {
    const c = (by[s.currency] ??= { currency: s.currency, shifts: 0, hours_x100: 0, km_x10: 0, orders: 0, gross: 0, tips: 0, costs: 0 });
    c.shifts++; c.hours_x100 += s.hours_x100; c.km_x10 += s.km_x10; c.orders += s.orders;
    c.gross += s.gross_cents; c.tips += s.tips_cents; c.costs += s.costs_cents;
  }
  return Object.values(by).map(c => {
    const net = c.gross + c.tips - c.costs;
    return { ...c, net, per_hour: c.hours_x100 ? Math.round(net * 100 / c.hours_x100) : null, per_km: c.km_x10 ? Math.round(net * 10 / c.km_x10) : null };
  });
}

export function toCSV(rows, columns) {
  const cell = v => {
    const s = v === null || v === undefined ? '' : String(v);
    // Neutraliza fórmulas (=, +, -, @) ao abrir no Excel/Sheets.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? "'" + s : s;
    return /[";\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  };
  return '﻿' + [columns.map(c => cell(c[1])).join(';'), ...rows.map(r => columns.map(c => cell(typeof c[0] === 'function' ? c[0](r) : r[c[0]])).join(';'))].join('\r\n');
}
