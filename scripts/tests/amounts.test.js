'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Amounts = require('../../public/js/amounts.js');

test('converts supplies above Number.MAX_SAFE_INTEGER exactly', () => {
  assert.equal(Amounts.toBaseUnits('21000000', 9), 21000000n * 10n ** 9n);
  assert.equal(Amounts.toBaseUnits('0.000000001', 9), 1n);
  assert.equal(Amounts.toBaseUnits('1.23', 2), 123n);
  assert.equal(Amounts.toBaseUnits('1.23000', 2), 123n, 'extra trailing zeroes do not change the exact amount');
});

test('formats raw token amounts without floating-point conversion', () => {
  assert.equal(Amounts.formatUnits(21000000000000000n, 9), '21000000');
  assert.equal(Amounts.formatUnits(1234567890123456789n, 9), '1234567890.123456789');
  assert.equal(Amounts.formatUnits(1234567890123456789n, 9, 6), '1234567890.123456');
});

test('rejects malformed, over-precision, and u64-overflow amounts', () => {
  assert.throws(() => Amounts.toBaseUnits('1e6', 9), /valid non-negative decimal/);
  assert.throws(() => Amounts.toBaseUnits('-1', 9), /valid non-negative decimal/);
  assert.throws(() => Amounts.toBaseUnits('0.001', 2), /more than 2 decimal places/);
  assert.equal(Amounts.toBaseUnits('18446744073709551615', 0), Amounts.U64_MAX);
  assert.throws(() => Amounts.toBaseUnits('18446744074', 9), /u64 maximum/);
});

test('parses exact unsigned integer fee values', () => {
  assert.equal(Amounts.toUnsignedInteger('18446744073709551615'), Amounts.U64_MAX);
  assert.throws(() => Amounts.toUnsignedInteger('1.5'), /whole non-negative number/);
  assert.throws(() => Amounts.toUnsignedInteger('18446744073709551616'), /exceeds the maximum/);
});
