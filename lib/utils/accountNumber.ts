/** Preserve SDK 0.55 account IDs through signing without a Number round trip. */
export function parseAccountNumber(value: unknown): bigint {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Unsafe numeric account number; use the original decimal string');
  }
  if (!['string', 'bigint', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw new Error('Invalid account number');
  }
  const result = BigInt(String(value));
  if (result > 18446744073709551615n) throw new Error('Account number exceeds uint64');
  return result;
}
export function parseSequence(value: unknown): number {
  const result = parseAccountNumber(value);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Sequence exceeds supported safe integer range');
  return Number(result);
}
