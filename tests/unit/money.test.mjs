import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatMoney, convert, parseRateMilli } from '../../public/shared/money.js';

test('parseAmount entende formatos pt-BR, pt-PT e en', () => {
  assert.equal(parseAmount('2.345,67'), 234567);
  assert.equal(parseAmount('2345,67'), 234567);
  assert.equal(parseAmount('2,345.67'), 234567);
  assert.equal(parseAmount('2345.67'), 234567);
  assert.equal(parseAmount('€ 12,5'), 1250);
  assert.equal(parseAmount('R$100.000'), 10000000);
  assert.equal(parseAmount('100.000,00'), 10000000);
  assert.equal(parseAmount('0,00'), 0);
  assert.equal(parseAmount('1.200'), 120000);
});

test('parseAmount rejeita lixo', () => {
  for (const bad of ['', 'abc', '12.34.56', '-5', '1,2,3', '12,345,67']) assert.equal(parseAmount(bad), null, bad);
});

test('formatMoney usa padrão brasileiro', () => {
  assert.equal(formatMoney(234567, 'EUR').replace(/\s/g, ' '), '€ 2.345,67');
  assert.equal(formatMoney(-2550, 'BRL').replace(/\s/g, ' '), '−R$ 25,50');
  assert.equal(formatMoney(100, 'EUR', { sign: true }).replace(/\s/g, ' '), '+€ 1,00');
});

test('convert usa taxa manual e recusa sem taxa', () => {
  assert.equal(convert(10000, 'EUR', 'BRL', 6250), 62500);
  assert.equal(convert(62500, 'BRL', 'EUR', 6250), 10000);
  assert.equal(convert(10000, 'EUR', 'BRL', null), null);
  assert.equal(convert(10000, 'EUR', 'EUR', null), 10000);
  assert.equal(parseRateMilli('6,2534'), 6253);
  assert.equal(parseRateMilli('x'), null);
});
