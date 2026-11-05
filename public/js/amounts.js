/* Exact decimal/base-unit conversion shared by the dashboard and Node tests. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenAmounts = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const U64_MAX = 18446744073709551615n;

  function validateDecimals(decimals) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      throw new Error('Decimals must be an integer from 0 to 255');
    }
  }

  /** Convert a plain UI decimal string to exact base units; never rounds silently. */
  function toBaseUnits(value, decimals, maxValue) {
    validateDecimals(decimals);
    const text = String(value == null ? '' : value).trim();
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
      throw new Error('Enter a valid non-negative decimal amount');
    }
    const [wholePart, rawFractionPart = ''] = text.split('.');
    let fractionPart = rawFractionPart;
    if (fractionPart.length > decimals) {
      const excess = fractionPart.slice(decimals);
      if (/[^0]/.test(excess)) throw new Error(`Amount has more than ${decimals} decimal places`);
      fractionPart = fractionPart.slice(0, decimals);
    }
    const whole = wholePart || '0';
    const fraction = fractionPart.padEnd(decimals, '0');
    const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
    const amount = BigInt(digits);
    const limit = maxValue == null ? U64_MAX : BigInt(maxValue);
    if (amount > limit) throw new Error('Amount exceeds the u64 maximum');
    return amount;
  }

  function toUnsignedInteger(value, maxValue, label) {
    const text = String(value == null ? '' : value).trim();
    if (!/^\d+$/.test(text)) throw new Error(`${label || 'Value'} must be a whole non-negative number`);
    const number = BigInt(text);
    const limit = maxValue == null ? U64_MAX : BigInt(maxValue);
    if (number > limit) throw new Error(`${label || 'Value'} exceeds the maximum`);
    return number;
  }

  function formatUnits(value, decimals, maxFractionDigits) {
    validateDecimals(decimals);
    let raw = BigInt(value);
    const negative = raw < 0n;
    if (negative) raw = -raw;
    if (decimals === 0) return `${negative ? '-' : ''}${raw.toString()}`;

    const padded = raw.toString().padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals);
    let fraction = padded.slice(-decimals);
    if (maxFractionDigits != null) {
      if (!Number.isInteger(maxFractionDigits) || maxFractionDigits < 0) {
        throw new Error('maxFractionDigits must be a non-negative integer');
      }
      fraction = fraction.slice(0, maxFractionDigits);
    }
    fraction = fraction.replace(/0+$/, '');
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
  }

  return { U64_MAX, toBaseUnits, toUnsignedInteger, formatUnits };
});
