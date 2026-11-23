/** Reuse unchanged JSON query snapshots so metadata writes do not rerender tables.
 * Non-JSON values keep their normal identity semantics (Date, Blob, Map, etc.).
 */
export function shareQueryResult<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  const array = Array.isArray(previous) && Array.isArray(next);
  const plain = (value: unknown): value is Record<string, unknown> =>
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype;
  if (!array && !(plain(previous) && plain(next))) return next;
  const before = previous as Record<string, unknown>,
    after = next as Record<string, unknown>;
  const keys = Object.keys(after),
    result: Record<string, unknown> = array
      ? ([...(next as unknown[])] as unknown as Record<string, unknown>)
      : { ...after };
  let equal =
    Object.keys(before).length === keys.length &&
    (!array || (previous as unknown[]).length === (next as unknown[]).length);
  for (const key of keys) {
    result[key] = shareQueryResult(before[key], after[key]);
    equal &&= Object.hasOwn(before, key) && Object.is(before[key], result[key]);
  }
  return equal ? previous : (result as T);
}
