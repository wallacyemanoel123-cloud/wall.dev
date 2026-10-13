// Extração de dados de recibos/screenshots a partir do texto (OCR feito no aparelho).
// Nada aqui é garantido: o resultado é sempre uma SUGESTÃO que o titular confirma.
import { parseAmount } from './money.js';
import { isDate } from './finance.js';

const MONTHS = {
  jan: 1, janeiro: 1, january: 1, fev: 2, feb: 2, fevereiro: 2, february: 2, mar: 3, marco: 3, march: 3,
  abr: 4, apr: 4, abril: 4, april: 4, mai: 5, may: 5, maio: 5, jun: 6, junho: 6, june: 6, jul: 7, julho: 7, july: 7,
  ago: 8, aug: 8, agosto: 8, august: 8, set: 9, sep: 9, sept: 9, setembro: 9, september: 9, out: 10, oct: 10, outubro: 10, october: 10,
  nov: 11, novembro: 11, november: 11, dez: 12, dec: 12, dezembro: 12, december: 12,
};
const plain = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const pad = n => String(n).padStart(2, '0');
const year = y => (y.length === 2 ? '20' + y : y);

export function extractDate(text) {
  const t = plain(text);
  let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m && isDate(`${m[1]}-${m[2]}-${m[3]}`)) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/);
  if (m) { const d = `${year(m[3])}-${pad(m[2])}-${pad(m[1])}`; if (isDate(d)) return d; }
  m = t.match(/\b(\d{1,2})(?:\s+de)?\s+([a-z]{3,9})\.?(?:\s+de)?,?\s+(\d{4})\b/);
  if (m && MONTHS[m[2]]) { const d = `${m[3]}-${pad(MONTHS[m[2]])}-${pad(m[1])}`; if (isDate(d)) return d; }
  m = t.match(/\b([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTHS[m[1]]) { const d = `${m[3]}-${pad(MONTHS[m[1]])}-${pad(m[2])}`; if (isDate(d)) return d; }
  return null;
}

export function extractCurrency(text) {
  const eur = (text.match(/€|\bEUR\b/gi) || []).length, brl = (text.match(/R\$|\bBRL\b/gi) || []).length;
  if (!eur && !brl) return null;
  return brl > eur ? 'BRL' : 'EUR';
}

const AMOUNT_RE = /(?:R\$|€|EUR|BRL)?\s?-?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})|(?:R\$|€)\s?\d+/gi;
const TOTAL_WORDS = /\b(total|valor|montante|amount|pago|paid|a pagar|cobrado|charged|transferido|sent|enviado)\b/;

export function extractAmount(text) {
  const lines = text.split(/\r?\n/);
  const candidates = [];
  lines.forEach((line, i) => {
    const p = plain(line);
    for (const raw of line.match(AMOUNT_RE) || []) {
      const cents = parseAmount(raw.replace(/-/g, '').replace(/(\d)\s(\d{3})/g, '$1.$2'));
      if (!cents) continue;
      const weight = (TOTAL_WORDS.test(p) ? 10 : 0) + (/€|R\$|EUR|BRL/i.test(raw) ? 3 : 0) + (/\b(iva|vat|imposto|troco|change|subtotal)\b/.test(p) ? -8 : 0);
      candidates.push({ cents, weight, i });
    }
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.weight - a.weight || b.cents - a.cents);
  return candidates[0].cents;
}

const NOISE = /^(recibo|receipt|comprovante|fatura|invoice|nif|nipc|cnpj|cpf|tel|telefone|data|date|hora|time|total|valor|iva|vat|obrigado|thank|www\.|http|\d)/;

export function extractMerchant(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/(?:pagamento\s+(?:para|a)|payment\s+to|paid\s+to|para|to)\s*[:\-]?\s+(.{2,60})$/i);
    if (m && /[a-z]/i.test(m[1])) return m[1].replace(/[€$].*$/, '').trim();
  }
  for (const line of lines.slice(0, 8)) {
    const p = plain(line);
    if (NOISE.test(p) || !/[a-z]{3}/i.test(line) || line.length > 60) continue;
    return line.replace(/\s{2,}/g, ' ');
  }
  return null;
}

export function parseReceipt(text) {
  const src = String(text || '').slice(0, 20000);
  const result = { date: extractDate(src), merchant: null, amount_cents: extractAmount(src), currency: extractCurrency(src) };
  // Sem valor nem data, o texto provavelmente não é um comprovante: não sugere estabelecimento.
  if (result.date || result.amount_cents) result.merchant = extractMerchant(src);
  result.found = Object.entries(result).filter(([, v]) => v !== null).map(([k]) => k);
  return result;
}
