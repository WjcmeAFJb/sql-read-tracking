/**
 * TypeScript declarations for sqlite3-read-tracking.
 *
 * Usage:
 *   import initSqliteTracked from "sqlite3-read-tracking";
 *   const SQL = await initSqliteTracked();
 *   const db = new SQL.Database();
 *   db.beginTracking();
 *   db.exec("SELECT * FROM users");
 *   console.log(db.getReadLog());
 */

export interface ModuleConfig {
  /** Callback that returns the URL of a support file (e.g. the .wasm). */
  locateFile?: (name: string) => string;
  /** Pre-supplied WebAssembly.Module or Memory for SSR bundlers. */
  wasmBinary?: ArrayBuffer | Uint8Array;
  [key: string]: unknown;
}

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface ExecResult {
  columns: string[];
  values: SqlValue[][];
}

export interface ReadLogEntry {
  /** Base-table name (index reads are surfaced as the index's owning table). */
  table: string;
  /** Integer primary key of the row touched. */
  rowid: number | bigint;
  /** Index into getQueryLog() identifying the originating statement. */
  query: number;
}

export interface QueryLogEntry {
  /** Original SQL text passed to prepare/exec. */
  sql: string;
  /** Result rows emitted by the statement (empty for mutative queries). */
  rows: SqlValue[][];
}

export declare class Statement {
  bind(values: SqlValue[] | Record<string, SqlValue>): boolean;
  step(): boolean;
  get(params?: SqlValue[] | Record<string, SqlValue>): SqlValue[] | null;
  getAsObject(
    params?: SqlValue[] | Record<string, SqlValue>,
  ): Record<string, SqlValue> | null;
  columnNames(): string[];
  reset(): boolean;
  free(): boolean;
}

export declare class Database {
  constructor(path?: string);
  readonly filename: string;

  /** Execute one or more SQL statements. */
  exec(sql: string, params?: SqlValue[] | Record<string, SqlValue>): ExecResult[];
  run(sql: string, params?: SqlValue[] | Record<string, SqlValue>): ExecResult[];

  /** Compile a statement for reuse. Remember to call free() when done. */
  prepare(
    sql: string,
    params?: SqlValue[] | Record<string, SqlValue>,
  ): Statement;

  /** Release the underlying SQLite connection. */
  close(): void;

  /** Enable read tracking. Previously collected data is cleared. */
  beginTracking(): this;
  /** Disable tracking. Collected data remains available until next begin/reset. */
  endTracking(): this;
  /** Discard collected reads/queries; tracking state is unchanged. */
  resetTracking(): this;
  /** Whether tracking is currently active. */
  isTracking(): boolean;
  /** Every row-level read since beginTracking(). */
  getReadLog(): ReadLogEntry[];
  /** Every executed statement plus the rows it emitted. */
  getQueryLog(): QueryLogEntry[];
  /** JSON-serialized dump of reads + queries. */
  dumpTracking(): string;
}

export interface SqliteTracked {
  Database: typeof Database;
  Statement: typeof Statement;
}

/** Factory -- load the WASM module and return a configured API. */
declare function initSqliteTracked(
  config?: ModuleConfig,
): Promise<SqliteTracked>;

export default initSqliteTracked;
