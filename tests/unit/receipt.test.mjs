import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt } from '../../public/shared/receipt.js';

test('recibo de supermercado (EUR)', () => {
  const r = parseReceipt(`LIDL IRELAND\nMain Street, Dublin\nVAT 23%  2,15\nTOTAL   € 12,99\nDate 13/10/2026 14:22\nThank you`);
  assert.equal(r.merchant, 'LIDL IRELAND'); assert.equal(r.amount_cents, 1299); assert.equal(r.currency, 'EUR'); assert.equal(r.date, '2026-10-13');
});

test('screenshot de transferência (Revolut/AstroPay)', () => {
  const r = parseReceipt(`Pagamento para Maria Silva\n-€2.345,67\n13 de outubro de 2026, 10:41\nConcluído`);
  assert.equal(r.merchant, 'Maria Silva'); assert.equal(r.amount_cents, 234567); assert.equal(r.date, '2026-10-13'); assert.equal(r.currency, 'EUR');
});

test('comprovante em reais', () => {
  const r = parseReceipt(`Comprovante de Pix\nValor: R$ 250,00\nData: 2026-10-01\nPara: Loja Exemplo LTDA`);
  assert.equal(r.currency, 'BRL'); assert.equal(r.amount_cents, 25000); assert.equal(r.date, '2026-10-01'); assert.equal(r.merchant, 'Loja Exemplo LTDA');
});

test('data em inglês e texto sem dados', () => {
  assert.equal(parseReceipt('Paid to Uber Eats\nOct 9, 2026\n€ 8.40').date, '2026-10-09');
  assert.deepEqual(parseReceipt('nada aqui').found, []);
});
