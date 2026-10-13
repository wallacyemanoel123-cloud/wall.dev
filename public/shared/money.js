// Dinheiro em centavos inteiros. Nunca use float para somar valores.
export const CURRENCIES = ['EUR', 'BRL'];
export const SYMBOL = { EUR: '€', BRL: 'R$' };

// Aceita "2.345,67", "2345,67", "2,345.67", "2345.67", "€ 12,50", "R$100.000".
// Regra: o último separador seguido de 1–2 dígitos é decimal; um separador seguido
// de exatamente 3 dígitos é milhar (padrão pt-BR/pt-PT). Retorna centavos ou null.
export function parseAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) : null;
  const s = String(input ?? '').trim().replace(/R\$|€|EUR|BRL|\s/gi, '');
  if (!s || !/^\d[\d.,]*$/.test(s)) return null;
  const decPos = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  let whole = s, frac = '';
  if (decPos >= 0) {
    const tail = s.slice(decPos + 1);
    const sep = s[decPos];
    const single = s.indexOf(sep) === decPos;
    if (/^\d{1,2}$/.test(tail) && (single || s.includes(sep === ',' ? '.' : ','))) {
      whole = s.slice(0, decPos); frac = tail;
    } else if (!/^\d{3}$/.test(tail)) return null;
  }
  // Grupos de milhar precisam ter 3 dígitos.
  const groups = whole.split(/[.,]/);
  if (groups.length > 1 && groups.slice(1).some(g => g.length !== 3)) return null;
  const digits = groups.join('');
  if (!/^\d{1,12}$/.test(digits)) return null;
  return Number(digits) * 100 + Number((frac + '00').slice(0, 2));
}

export function formatMoney(cents, currency = 'EUR', { sign = false } = {}) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  const f = new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(Math.abs(cents) / 100);
  if (cents < 0) return '−' + f;
  return sign && cents > 0 ? '+' + f : f;
}

// Conversão por taxa MANUAL informada pelo titular (não há cotação automática).
// eurBrlMilli = quantos BRL vale 1 EUR, em milésimos (6,1234 → 6123).
export function convert(cents, from, to, eurBrlMilli) {
  if (cents === null || cents === undefined) return null;
  if (from === to) return cents;
  if (!eurBrlMilli) return null;
  if (from === 'EUR' && to === 'BRL') return Math.round(cents * eurBrlMilli / 1000);
  if (from === 'BRL' && to === 'EUR') return Math.round(cents * 1000 / eurBrlMilli);
  return null;
}

export function parseRateMilli(input) {
  const s = String(input ?? '').trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(s)) return null;
  const v = Math.round(Number(s) * 1000);
  return v > 0 ? v : null;
}
