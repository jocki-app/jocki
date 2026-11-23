/** JSON results keep exact CSDB bigint values as decimal strings. */
export function CSDBSQLResult({ value }: { value: unknown }) {
  return (
    <pre
      aria-label="SQL result"
      className="overflow-auto rounded-lg bg-muted p-3 text-xs"
    >
      {JSON.stringify(
        value,
        (_key, item) => (typeof item === "bigint" ? item.toString() : item),
        2,
      )}
    </pre>
  );
}
