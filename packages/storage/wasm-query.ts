import { Table, tableToIPC, vectorFromArray, Utf8 } from "apache-arrow";
import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { identifier, type SqlValue, type SqlRow } from "./database";
const pendingCleanup = new WeakMap<AsyncDuckDBConnection, Set<string>>();
const bindings = new WeakMap<AsyncDuckDBConnection, string>();
const bindingTable = (name: string) =>
  `CREATE TEMP TABLE IF NOT EXISTS ${identifier(name)} (value VARCHAR)`;
async function releaseBinding(connection: AsyncDuckDBConnection, name: string) {
  let failure: unknown;
  for (const query of [
    `RESET VARIABLE ${identifier(name)}`,
    `${bindingTable(name)}; DELETE FROM ${identifier(name)}`,
  ]) {
    try {
      await connection.query(query);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) {
    let pending = pendingCleanup.get(connection);
    if (!pending) pendingCleanup.set(connection, (pending = new Set()));
    pending.add(name);
  } else pendingCleanup.get(connection)?.delete(name);
  return failure;
}
/** Replace placeholders with references to a transaction-scoped Arrow relation, never with user text. */
function parameters(sql: string, table: string, values: SqlValue[]) {
  let result = "",
    position = 0,
    index = 0;
  while (position < sql.length) {
    const char = sql[position];
    if (char === "'" || char === '"') {
      const quote = char;
      result += char;
      position++;
      while (position < sql.length) {
        const next = sql[position++];
        result += next;
        if (next === quote) {
          if (sql[position] === quote) {
            result += sql[position++];
          } else break;
        }
      }
    } else if (sql.startsWith("--", position)) {
      const end = sql.indexOf("\n", position);
      result += sql.slice(position, end < 0 ? sql.length : end);
      position = end < 0 ? sql.length : end;
    } else if (sql.startsWith("/*", position)) {
      const end = sql.indexOf("*/", position + 2);
      if (end < 0) throw Error("Unterminated SQL comment");
      result += sql.slice(position, end + 2);
      position = end + 2;
    } else if (
      char === "?" ||
      (char === "$" && /^\$\d+/.test(sql.slice(position)))
    ) {
      const token = char === "?" ? "?" : /^\$\d+/.exec(sql.slice(position))![0];
      const param = char === "?" ? index++ : Number(token.slice(1)) - 1;
      if (param < 0 || param >= values.length)
        throw Error("SQL parameter count mismatch");
      const value = values[param];
      const extracted = `json_extract_string(getvariable('${table}'), '$[${param}]')`;
      result +=
        value === null
          ? "NULL"
          : typeof value === "number"
            ? Number.isFinite(value)
              ? `CAST(${extracted} AS DOUBLE)`
              : `CAST('${String(value)}' AS DOUBLE)`
            : typeof value === "boolean"
              ? `CAST(${extracted} AS BOOLEAN)`
              : `(${extracted})`;
      position += token.length;
    } else {
      result += char;
      position++;
    }
  }
  return result;
}
/** Arrow IPC avoids the Wasm prepared-parameter stack limit for large JSON and file BLOBs. */
export async function wasmQuery<T extends SqlRow>(
  connection: AsyncDuckDBConnection,
  sql: string,
  values: SqlValue[] = [],
): Promise<T[]> {
  if (!values.length) {
    const result = (await connection.query(sql))
      .toArray()
      .map((row) => row.toJSON()) as T[];
    // RESET is refused while a transaction is aborted. Retry after its owner's
    // ROLLBACK, so failed statements cannot retain large session variables.
    for (const name of pendingCleanup.get(connection) ?? [])
      await releaseBinding(connection, name);
    return result;
  }
  if (
    values.length <= 64 &&
    values.reduce<number>(
      (size, value) =>
        size + (typeof value === "string" ? value.length * 3 : 16),
      0,
    ) < 8192
  ) {
    const statement = await connection.prepare(sql);
    try {
      return (await statement.query(...values))
        .toArray()
        .map((row) => row.toJSON()) as T[];
    } finally {
      await statement.close();
    }
  }
  let name = bindings.get(connection);
  if (!name) {
    name = "_jocki_parameters_" + crypto.randomUUID().replaceAll("-", "");
    bindings.set(connection, name);
  }
  // One stable, single-column scratch table per connection. Creating/dropping a
  // wide Arrow table for each statement retains its blocks until COMMIT, even
  // after DROP, and can exhaust a mobile WebContent process during replay.
  const table = new Table({
    value: vectorFromArray([JSON.stringify(values)], new Utf8()),
  });
  await connection.query(bindingTable(name));
  let failed = false;
  try {
    await connection.insertArrowFromIPCStream(tableToIPC(table, "stream"), {
      name,
      create: false,
    });
    // A flat JSON variable keeps parameters out of SQL text without generating
    // hundreds of scalar subqueries (which overflow WebKit's Wasm call stack).
    await connection.query(
      `SET VARIABLE ${identifier(name)} = (SELECT value::JSON FROM ${identifier(name)})`,
    );
    return (await connection.query(parameters(sql, name, values)))
      .toArray()
      .map((row) => row.toJSON()) as T[];
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const error = await releaseBinding(connection, name);
    if (error && !failed) throw error;
  }
}
