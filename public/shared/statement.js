// Importação de extrato bancário em CSV (Revolut, AstroPay ou qualquer banco que exporte CSV).
// Não há integração direta com bancos: o titular baixa o CSV no app do banco e envia aqui.
import { parseAmount } from './money.js';
import { isDate } from './finance.js';

export function parseCSV(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] || '';
  const delim = [';', ',', '\t'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  const headers = (rows.shift() || []).map(h => h.trim());
  return { delimiter: delim, headers, rows: rows.slice(0, 5000) };
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const find = (headers, names) => { const h = headers.map(norm); for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } for (const n of names) { const i = h.findIndex(x => x.includes(n)); if (i >= 0) return i; } return -1; };

// Detecta as colunas pelo nome do cabeçalho. O titular pode corrigir na tela.
export function detectColumns(headers) {
  const revolut = ['type', 'product', 'started date', 'completed date', 'description', 'amount'].every(n => headers.map(norm).includes(n));
  return {
    preset: revolut ? 'Revolut' : 'Genérico',
    date: find(headers, ['completed date', 'data', 'date', 'data do lancamento', 'data da transacao', 'started date', 'fecha']),
    date2: revolut ? find(headers, ['started date']) : -1,
    description: find(headers, ['description', 'descricao', 'historico', 'detalhes', 'details', 'merchant', 'estabelecimento', 'concepto']),
    amount: find(headers, ['amount', 'valor', 'montante', 'quantia', 'importe']),
    debit: find(headers, ['debito', 'debit', 'saida', 'paid out']),
    credit: find(headers, ['credito', 'credit', 'entrada', 'paid in']),
    fee: find(headers, ['fee', 'taxa', 'tarifa']),
    currency: find(headers, ['currency', 'moeda', 'divisa']),
    state: find(headers, ['state', 'status', 'estado', 'situacao']),
    type: revolut ? find(headers, ['type']) : -1,
  };
}

export function parseStatementDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m && isDate(`${m[1]}-${m[2]}-${m[3]}`)) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/);
  if (m) { const d = `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; if (isDate(d)) return d; }
  return null;
}

// Valor com sinal: "-12.50", "(12,50)", "12,50-", "−12,50", "€ -3,00".
export function parseSignedAmount(s) {
  let t = String(s ?? '').trim().replace(/−/g, '-');
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/-\s*$/.test(t)) { neg = true; t = t.replace(/-\s*$/, ''); }
  if (/-/.test(t)) { neg = true; t = t.replace(/-/g, ''); }
  t = t.replace(/^\+/, '');
  const c = parseAmount(t);
  return c === null ? null : neg ? -c : c;
}

const SKIP_STATES = ['reverted', 'declined', 'failed', 'cancelled', 'canceled', 'revertida', 'recusada', 'cancelada', 'estornada'];
const PENDING_STATES = ['pending', 'pendente', 'em processamento'];
// Movimentos que costumam ser dinheiro indo de uma conta sua para outra (não é receita nem despesa).
const TRANSFER_TYPES = ['transfer', 'topup', 'top-up', 'exchange'];
const TRANSFER_DESC = /^(to|from) (eur|brl|usd|gbp)\b|^exchanged? to\b|^(top-?up|recarga)\b|transfer(e|ê)ncia entre contas/i;
export const looksLikeTransfer = (type, description) => TRANSFER_TYPES.includes(norm(type)) || TRANSFER_DESC.test(String(description || '').trim());

export function toTransactions(parsed, cols, defaultCurrency) {
  const out = [], errors = [];
  parsed.rows.forEach((r, i) => {
    const line = i + 2;
    const state = cols.state >= 0 ? norm(r[cols.state]) : '';
    if (SKIP_STATES.includes(state)) { errors.push({ line, reason: `ignorada (situação “${r[cols.state]}”)` }); return; }
    // Pendentes na Revolut ainda não têm data de conclusão: usa a data de início.
    const date = parseStatementDate(r[cols.date]) || (cols.date2 >= 0 ? parseStatementDate(r[cols.date2]) : null);
    let amount = null;
    if (cols.amount >= 0 && String(r[cols.amount] ?? '').trim()) amount = parseSignedAmount(r[cols.amount]);
    else {
      const d = cols.debit >= 0 ? parseSignedAmount(r[cols.debit]) : null, c = cols.credit >= 0 ? parseSignedAmount(r[cols.credit]) : null;
      if (d) amount = -Math.abs(d); else if (c) amount = Math.abs(c);
    }
    const fee = cols.fee >= 0 ? Math.abs(parseSignedAmount(r[cols.fee]) || 0) : 0;
    const description = String(r[cols.description] ?? '').trim().slice(0, 200);
    if (!date) { errors.push({ line, reason: 'data não reconhecida' }); return; }
    if (amount === null || amount === 0) { errors.push({ line, reason: 'valor não reconhecido ou zero' }); return; }
    const currency = cols.currency >= 0 && /^(EUR|BRL)$/i.test(String(r[cols.currency]).trim()) ? String(r[cols.currency]).trim().toUpperCase() : defaultCurrency;
    const transfer = looksLikeTransfer(cols.type >= 0 ? r[cols.type] : '', description);
    out.push({ line, date, description: description || 'Sem descrição', amount_cents: amount - fee, currency, pending: PENDING_STATES.includes(state), transfer });
  });
  return { rows: out, errors };
}
