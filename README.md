# sqlite3-read-tracking

SQLite 3.47.2 compiled to WebAssembly with per-transaction read tracking
built into the VDBE. Every `(table, rowid)` touched during execution --
including the implicit cursor reads driven by conditional `UPDATE`, `DELETE`,
and `INSERT ... SELECT` statements -- surfaces in a log, alongside a
`(SQL, rows)` record of each statement run inside the tracking window.

Built for change-data-capture, cache invalidation, replication audit, and
any workload that needs to answer "which rows did this transaction look
at, not just the ones it wrote?"

This repo is a small fork of SQLite that adds tracking hooks; SQLite itself
remains in the public domain. See [`LICENSE`](./LICENSE) for the tracking
layer's terms.

Companion libraries that use this:

- [**sql-git**](https://github.com/WjcmeAFJb/sql-git) — distributed
  SQLite with rebase-style conflict resolution; uses the read-set
  tracking for fast-path convergence detection.
- [**sql-reactive-orm**](https://github.com/WjcmeAFJb/sql-reactive-orm) —
  reactive ORM for React + SQLite.

## Install

Release tarballs are attached to every GitHub release:

```bash
pnpm add 'https://github.com/WjcmeAFJb/sql-read-tracking/releases/download/v0.2.0/sqlite3-read-tracking-0.2.0.tgz'
```

Or via a git tag:

```bash
pnpm add 'github:WjcmeAFJb/sql-read-tracking#v0.2.0'
```

The package ships with the pre-built `dist/sqlite3-tracked.wasm` and the
ESM loader, so consumers don't need emscripten. Bundlers such as Vite
pick up the WASM automatically via the `./wasm` sub-export:

```ts
import initSqliteTracked from "sqlite3-read-tracking";
import wasmUrl from "sqlite3-read-tracking/wasm?url";

const SQL = await initSqliteTracked({ locateFile: () => wasmUrl });
```

## Quick start

```js
import initSqliteTracked from "sqlite3-read-tracking";

const SQL = await initSqliteTracked();
const db = new SQL.Database();

db.exec(`
  CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, age INT);
  CREATE TABLE posts(id INTEGER PRIMARY KEY, user_id INT, body TEXT);
  INSERT INTO users VALUES(1,'alice',30),(2,'bob',40);
  INSERT INTO posts VALUES(10,1,'hi'),(11,2,'yo');
`);

db.beginTracking();
db.exec(`
  UPDATE users SET age=age+1
  WHERE id IN (SELECT user_id FROM posts WHERE body='hi');
`);
db.endTracking();

console.log(db.getReadLog());
// [
//   { table: 'posts', rowid: 10, query: 0 },
//   { table: 'posts', rowid: 11, query: 0 },
//   { table: 'users', rowid: 1,  query: 0 },
// ]

console.log(db.getQueryLog());
// [{ sql: 'UPDATE users SET age=age+1 WHERE id IN (...)', rows: [] }]

db.close();
```

## API

### `initSqliteTracked(config?) -> Promise<{ Database, Statement }>`

Loads the WASM. Pass `{ locateFile }` when you need to control where the
`.wasm` is fetched from (CDN, bundler asset URL, Node `fs`, etc.).

### `new Database(path = ':memory:')`

Opens a SQLite connection. Same constructor signature as `sql.js`.

### Tracking methods

| Method | Returns | Notes |
| ------ | ------- | ----- |
| `db.beginTracking()` | `this` | Enable tracking; clear any prior log. |
| `db.endTracking()` | `this` | Stop recording. The log stays accessible. |
| `db.resetTracking()` | `this` | Clear log, keep tracking state. |
| `db.isTracking()` | `boolean` | |
| `db.getReadLog()` | `ReadLogEntry[]` | `{table, rowid, query}` per row touched. |
| `db.getQueryLog()` | `QueryLogEntry[]` | `{sql, rows}` per statement run. |
| `db.dumpTracking()` | `string` | Both logs as a single JSON document. |

### `ReadLogEntry`

```ts
interface ReadLogEntry {
  table: string;       // base table name (indices roll up to their table)
  rowid: number | bigint;
  query: number;       // index into getQueryLog()
}
```

### `QueryLogEntry`

```ts
interface QueryLogEntry {
  sql: string;         // the SQL text as passed to exec()/prepare()
  rows: SqlValue[][];  // rows emitted via OP_ResultRow (empty for mutations)
}
```

## What "reads" means here

A row-access event is emitted from the following VDBE opcodes, all of
which imply the contents of a row were (or could have been) inspected:

- `OP_Column` on a table btree cursor
- `OP_Rowid` on a table btree cursor
- `OP_SeekRowid` / `OP_NotExists` (successful and failed probes)
- `OP_Found` / `OP_NotFound` / `OP_NoConflict` on index cursors
- `OP_IdxRowid` / `OP_DeferredSeek` (index -> table lookups)

Notes:

- Reads are deduplicated per-statement. If the same `(table, rowid)`
  pair is visited multiple times by nested loops inside a single
  statement, it appears once in the log.
- Ephemeral tables (CTE materializations, sorter btrees) are skipped:
  their rows have no stable rowid to cite.
- `SELECT COUNT(*)` uses `OP_Count` which reads btree metadata, not
  row data. It is reported in `getQueryLog()` but emits no entries in
  `getReadLog()`. `SELECT SUM(col)` does scan.
- Triggers execute inside the parent statement's Vdbe, so their reads
  attach to that statement's `query` index.

## Bytecode changes

The amalgamation in `vendor/sqlite3.c` contains clearly-marked
`BEGIN/END read-tracking` hunks in:

- `struct Vdbe` -- an extra `iTrackQuery` field per prepared statement.
- `sqlite3VdbeCreate`, `sqlite3VdbeReset` -- initialise / reset that field.
- `sqlite3Step` -- registers a new query with the tracker on the
  READY -> RUN transition.
- `OP_Column`, `OP_Rowid`, `OP_SeekRowid` + `OP_NotExists`,
  `OP_Found` + `OP_NotFound` + `OP_NoConflict`, `OP_IdxRowid` +
  `OP_DeferredSeek`, `OP_ResultRow` -- row-access + result-row hooks.
- End of file -- helper functions that resolve `pgnoRoot` to table
  name and serialize `Mem` values as JSON.

All tracker state lives in `src/track.c`; the amalgamation only calls
through a small set of `extern` hooks.

## Build from source

The shipping build only requires `emcc`; the source tree also supports
a Node-hosted test binary for fast iteration.

```bash
# Build the npm-ready artifact (-> dist/sqlite3-tracked.{mjs,wasm,d.mts})
npm run build

# Build + run the C-level test harness
npm run build:test && npm run test:native

# Build + run the Vitest E2E suite against dist/
npm test
```

The CI workflow (`.github/workflows/ci.yml`) does the same steps on
every push: installs emscripten via `mymindstorm/setup-emsdk`, runs the
native + E2E + browser suites. The release workflow
(`.github/workflows/release.yml`) runs on tag pushes matching `v*` and
publishes a tarball as a GitHub release asset.

## License

SQLite itself — the contents of `vendor/sqlite3.{c,h}` — is in the
public domain (see https://www.sqlite.org/copyright.html). The
tracking layer added under `src/` is distributed under the terms of
[`LICENSE`](./LICENSE) (MIT).
