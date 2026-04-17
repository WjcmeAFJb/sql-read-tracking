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

export type WriteOp = "insert" | "update" | "delete" | "truncate";

export interface WriteLogEntry {
  table: string;
  /** rowid for insert/delete. -1 for truncate (wildcard -- matches any rowid). */
  rowid: number | bigint;
  op: WriteOp;
  query: number;
}

export type SqlKey = (null | number | string | Uint8Array)[];

export interface PredicateLogEntry {
  table: string;
  /** Index name, or null for a scan on the main table (primary key / rowid). */
  index: string | null;
  /** 's' = seek (range opened), 'e' = terminator (range closed), 'r' = rewind (full scan) */
  kind: "s" | "e" | "r";
  /** 'G' GE (incl), 'g' GT (excl), 'L' LE (incl), 'l' LT (excl), 'F' full */
  op: "G" | "g" | "L" | "l" | "F";
  /** Key vector for this boundary; null for full-scan events. */
  key: SqlKey | null;
  query: number;
}

export interface IndexWriteLogEntry {
  table: string;
  /** Index name. Phantom detection should only compare keys across events
   *  that share the same index, because key vectors from different
   *  indexes have no meaningful ordering. */
  index: string | null;
  /** Unpacked index key vector (last element is the rowid for rowid-table indexes). */
  key: SqlKey;
  rowid: number | bigint;
  op: "insert" | "delete";
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
  /** Every row-level write since beginTracking().
   *  Captured at the VDBE layer (OP_Insert/OP_Delete/OP_Clear) so it
   *  covers the truncate optimization and ON CONFLICT REPLACE paths that
   *  sqlite3_update_hook misses. */
  getWriteLog(): WriteLogEntry[];
  /** Predicate (range) reads captured at OP_SeekGE/GT/LE/LT and their
   *  OP_IdxGE/GT/LE/LT terminators. Used by phantom detection: pair up
   *  'seek' and 'end' events for the same table (same query, same
   *  cursor, no other events between them) to reconstruct the scanned
   *  range, then check concurrent index-writes against that range. */
  getPredicateLog(): PredicateLogEntry[];
  /** Every OP_IdxInsert / OP_IdxDelete with its unpacked key vector.
   *  Pair with getPredicateLog() to detect phantom conflicts: T2's
   *  index-write whose key falls within T1's predicate range is a
   *  rw-dependency even if the row didn't exist during T1's scan. */
  getIndexWriteLog(): IndexWriteLogEntry[];
  /** Every executed statement plus the rows it emitted. */
  getQueryLog(): QueryLogEntry[];
  /** JSON-serialized dump of reads + writes + queries. */
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
