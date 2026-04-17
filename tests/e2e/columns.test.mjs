/**
 * Column-level read tracking E2E.
 *
 * Every OP_Column logs which specific table column was extracted. This
 * is what lets a rw-graph consumer tell two UPDATEs that touch disjoint
 * column sets apart, even when they both write the same row.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import initSqliteTracked from "../../dist/sqlite3-tracked.js";

let SQL;
beforeAll(async () => { SQL = await initSqliteTracked(); });

let db;
beforeEach(() => {
  db = new SQL.Database();
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, age INT, tier TEXT);
    INSERT INTO users VALUES(1,'alice',30,'silver'),(2,'bob',40,'gold');
  `);
});
afterEach(() => { db.close(); });

describe("OP_Column events", () => {
  test("SELECT of specific columns logs only those columns", () => {
    db.beginTracking();
    db.exec("SELECT name FROM users");
    const log = db.getReadLog().filter(r => r.table === "users");
    const cols = new Set(log.map(r => r.column));
    expect(cols.has("name")).toBe(true);
    expect(cols.has("age")).toBe(false);
    expect(cols.has("tier")).toBe(false);
  });

  test("SELECT * touches every non-PK column via OP_Column", () => {
    db.beginTracking();
    db.exec("SELECT * FROM users WHERE id=1");
    const cols = new Set(
      db.getReadLog().filter(r => r.table === "users").map(r => r.column)
    );
    expect(cols.has("name")).toBe(true);
    expect(cols.has("age")).toBe(true);
    expect(cols.has("tier")).toBe(true);
    /* The 'rowid' event comes from the SeekRowid probe, not OP_Column. */
    expect(cols.has("rowid")).toBe(true);
  });

  test("columnIndex is populated for OP_Column events", () => {
    db.beginTracking();
    db.exec("SELECT age FROM users WHERE id=1");
    const ageRead = db.getReadLog().find(r => r.column === "age");
    expect(ageRead).toBeTruthy();
    expect(ageRead.columnIndex).toBe(2); // id=0, name=1, age=2, tier=3
  });

  test("rowid events carry columnIndex = -1", () => {
    db.beginTracking();
    db.exec("SELECT name FROM users WHERE id=1");
    const rowidRead = db.getReadLog().find(
      r => r.table === "users" && r.column === "rowid"
    );
    expect(rowidRead).toBeTruthy();
    expect(rowidRead.columnIndex).toBe(-1);
  });
});

describe("rw-graph impact of column granularity", () => {
  /* The point of column-level reads for serialisable analysis: when T1
  ** reads only column C and T2 writes only column D of the same row,
  ** there's no rw-dependency. */
  test("T1 reads col A, T2 writes col B on same row -> no column overlap", () => {
    db.beginTracking();
    db.exec("SELECT name FROM users WHERE id=1");
    const t1Cols = new Set(
      db.getReadLog()
        .filter(r => r.table === "users" && r.rowid === 1 && r.column !== "rowid")
        .map(r => r.column)
    );
    db.resetTracking();

    db.beginTracking();
    db.exec("UPDATE users SET age=31 WHERE id=1");
    const t2WriteCols = db.getWriteLog()[0]?.columns ?? [];

    const overlap = t2WriteCols.filter(c => t1Cols.has(c));
    expect(overlap).toEqual([]);
  });

  test("T1 reads col A, T2 writes col A on same row -> column overlap", () => {
    db.beginTracking();
    db.exec("SELECT name FROM users WHERE id=1");
    const t1Cols = new Set(
      db.getReadLog()
        .filter(r => r.table === "users" && r.rowid === 1 && r.column !== "rowid")
        .map(r => r.column)
    );
    db.resetTracking();

    db.beginTracking();
    db.exec("UPDATE users SET name='NEW' WHERE id=1");
    const t2WriteCols = db.getWriteLog()[0].columns;

    const overlap = t2WriteCols.filter(c => t1Cols.has(c));
    expect(overlap).toEqual(["name"]);
  });

  test("SET age=age+1 reads age -- distinguishes self-referential updates", () => {
    /* A SET expression that references its own column produces an
    ** OP_Column read of that column. Downstream tools can use this to
    ** tell `SET age=99` (not self-ref) from `SET age=age+1` (self-ref)
    ** and correctly keep the rw edge against a concurrent age update. */
    db.beginTracking();
    db.exec("UPDATE users SET age=age+1 WHERE id=1");
    const ageRead = db.getReadLog().find(
      r => r.table === "users" && r.rowid === 1 && r.column === "age"
    );
    expect(ageRead).toBeTruthy();
  });
});

describe("JSON dump carries column names", () => {
  test("dumpTracking includes the column field on every read entry", () => {
    db.beginTracking();
    db.exec("SELECT name, age FROM users WHERE id=1");
    const doc = JSON.parse(db.dumpTracking());
    expect(doc.reads.length).toBeGreaterThan(0);
    for (const r of doc.reads) {
      expect(typeof r.column).toBe("string");
    }
    const cols = new Set(doc.reads.map(r => r.column));
    expect(cols.has("name")).toBe(true);
    expect(cols.has("age")).toBe(true);
  });
});
