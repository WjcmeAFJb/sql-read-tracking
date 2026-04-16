/**
 * E2E tests exercising the sqlite3-read-tracking WASM build the way a
 * downstream npm consumer would: `import` the default factory from the
 * shipped dist, construct a Database, run SQL, inspect the logs.
 *
 * These tests run against the *built* artifact in ./dist, not the C
 * source -- they validate that bindings, JSON shape, and lifecycle all
 * survive the emscripten link step.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import initSqliteTracked from "../../dist/sqlite3-tracked.js";

let SQL;

beforeAll(async () => {
  SQL = await initSqliteTracked();
});

function seed(db){
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, age INT);
    CREATE TABLE posts(id INTEGER PRIMARY KEY, user_id INT, body TEXT);
    CREATE INDEX posts_user ON posts(user_id);
    INSERT INTO users VALUES(1,'alice',30),(2,'bob',40),(3,'carol',25);
    INSERT INTO posts VALUES(10,1,'hi'),(11,1,'hello'),(12,2,'howdy'),(13,3,'hey');
  `);
}

let db;
beforeEach(() => { db = new SQL.Database(); seed(db); });
afterEach(() => { db.close(); });

describe("Database lifecycle", () => {
  test("open/exec/close basic flow", () => {
    const res = db.exec("SELECT id FROM users ORDER BY id");
    expect(res).toEqual([{ columns: ["id"], values: [[1],[2],[3]] }]);
  });

  test("tracking defaults to off", () => {
    expect(db.isTracking()).toBe(false);
    db.exec("SELECT * FROM users WHERE id=1");
    expect(db.getReadLog()).toEqual([]);
    expect(db.getQueryLog()).toEqual([]);
  });

  test("beginTracking/endTracking toggles state", () => {
    expect(db.isTracking()).toBe(false);
    db.beginTracking();
    expect(db.isTracking()).toBe(true);
    db.endTracking();
    expect(db.isTracking()).toBe(false);
  });
});

describe("Read log: simple queries", () => {
  test("point lookup via primary key", () => {
    db.beginTracking();
    db.exec("SELECT * FROM users WHERE id=2");
    const reads = db.getReadLog();
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ table: "users", rowid: 2, query: 0 });
  });

  test("full table scan records every row", () => {
    db.beginTracking();
    db.exec("SELECT name FROM users");
    const rows = db.getReadLog().filter(r => r.table === "users").map(r => r.rowid);
    expect(rows.sort()).toEqual([1,2,3]);
  });

  test("WHERE-filtered scan still reads every row scanned", () => {
    db.beginTracking();
    db.exec("SELECT name FROM users WHERE age>=30");
    // SQLite without an index scans every row; the filter happens after read.
    const rids = db.getReadLog().filter(r => r.table === "users").map(r => r.rowid);
    expect(rids.sort()).toEqual([1,2,3]);
  });

  test("index-backed lookup resolves reads to base table name", () => {
    db.beginTracking();
    db.exec("SELECT body FROM posts WHERE user_id=1");
    const reads = db.getReadLog();
    // Should see reads of posts.10 and posts.11 -- never "posts_user".
    expect(reads.every(r => r.table === "posts")).toBe(true);
    const rids = reads.map(r => r.rowid);
    expect(rids).toContain(10);
    expect(rids).toContain(11);
    expect(rids).not.toContain(12);
    expect(rids).not.toContain(13);
  });
});

describe("Read log: CTEs and joins", () => {
  test("CTE feeds into outer query and both sets of reads are tracked", () => {
    db.beginTracking();
    db.exec(`
      WITH adults AS (SELECT id FROM users WHERE age>=30)
      SELECT u.name FROM users u JOIN adults a ON a.id=u.id;
    `);
    const userReads = db.getReadLog().filter(r => r.table === "users").map(r => r.rowid);
    expect(userReads).toContain(1); // alice 30
    expect(userReads).toContain(2); // bob 40
    // carol (age 25) is excluded from "adults" but her row was still scanned.
    expect(userReads).toContain(3);
  });

  test("multi-table join tracks reads on both sides", () => {
    db.beginTracking();
    db.exec(`
      SELECT u.name, p.body FROM users u
      JOIN posts p ON p.user_id=u.id
      WHERE u.id IN (1,2);
    `);
    const log = db.getReadLog();
    expect(log.some(r => r.table === "users" && r.rowid === 1)).toBe(true);
    expect(log.some(r => r.table === "users" && r.rowid === 2)).toBe(true);
    expect(log.some(r => r.table === "posts" && r.rowid === 10)).toBe(true);
    expect(log.some(r => r.table === "posts" && r.rowid === 11)).toBe(true);
    expect(log.some(r => r.table === "posts" && r.rowid === 12)).toBe(true);
    expect(log.some(r => r.table === "posts" && r.rowid === 13)).toBe(false);
  });
});

describe("Read log: mutative statements", () => {
  test("UPDATE with subquery tracks reads from both the subquery and the target", () => {
    db.beginTracking();
    db.exec(`
      UPDATE users SET age=age+1
      WHERE id IN (SELECT user_id FROM posts WHERE body='hello');
    `);
    const log = db.getReadLog();
    // The subquery scanned posts looking for body='hello' (posts.11 matches).
    expect(log.some(r => r.table === "posts" && r.rowid === 11)).toBe(true);
    // The outer UPDATE then reads users.1 to mutate it.
    expect(log.some(r => r.table === "users" && r.rowid === 1)).toBe(true);
    // Only one *statement* was executed.
    expect(db.getQueryLog()).toHaveLength(1);
  });

  test("DELETE tracks the rows it deletes before deleting them", () => {
    db.beginTracking();
    db.exec("DELETE FROM posts WHERE user_id=3");
    const log = db.getReadLog().filter(r => r.table === "posts");
    expect(log.map(r => r.rowid)).toContain(13);
    expect(log.map(r => r.rowid)).not.toContain(10);
  });

  test("INSERT ... SELECT tracks the source scan", () => {
    db.beginTracking();
    db.exec(`
      CREATE TABLE audit(id INTEGER PRIMARY KEY, who TEXT);
      INSERT INTO audit(who) SELECT name FROM users WHERE age>30;
    `);
    const rids = db.getReadLog().filter(r => r.table === "users").map(r => r.rowid);
    expect(rids.sort()).toEqual([1,2,3]);
  });
});

describe("Query log", () => {
  test("records (sql, rows) for each statement", () => {
    db.beginTracking();
    db.exec("SELECT id FROM users WHERE id=1");
    db.exec("SELECT id FROM users WHERE id=2");
    const log = db.getQueryLog();
    expect(log).toHaveLength(2);
    expect(log[0].sql.trim()).toBe("SELECT id FROM users WHERE id=1");
    expect(log[0].rows).toEqual([[1]]);
    expect(log[1].sql.trim()).toBe("SELECT id FROM users WHERE id=2");
    expect(log[1].rows).toEqual([[2]]);
  });

  test("emits empty rows for mutative queries but still logs the SQL", () => {
    db.beginTracking();
    db.exec("INSERT INTO users VALUES(4,'dave',50)");
    const log = db.getQueryLog();
    expect(log).toHaveLength(1);
    expect(log[0].sql).toMatch(/INSERT/);
    expect(log[0].rows).toEqual([]);
  });

  test("captures NULL, strings with quotes, and numeric types", () => {
    db.beginTracking();
    db.exec(`
      CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT, x);
      INSERT INTO t VALUES(1,'a "quoted" string', NULL);
      INSERT INTO t VALUES(2,'with
newline', 3.14);
    `);
    db.exec("SELECT * FROM t ORDER BY id");
    const rows = db.getQueryLog().at(-1).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([1, 'a "quoted" string', null]);
    expect(rows[1][0]).toBe(2);
    expect(rows[1][1]).toBe('with\nnewline');
    expect(rows[1][2]).toBeCloseTo(3.14);
  });
});

describe("Transaction scope", () => {
  test("reads and queries accumulate across a BEGIN/COMMIT block", () => {
    db.beginTracking();
    db.exec("BEGIN;");
    db.exec("SELECT * FROM users WHERE id=1;");
    db.exec("UPDATE users SET age=31 WHERE id=1;");
    db.exec("SELECT * FROM posts WHERE user_id=1;");
    db.exec("COMMIT;");
    const queries = db.getQueryLog();
    expect(queries.length).toBeGreaterThanOrEqual(3);
    const reads = db.getReadLog();
    expect(reads.some(r => r.table === "users" && r.rowid === 1)).toBe(true);
    expect(reads.some(r => r.table === "posts" && r.rowid === 10)).toBe(true);
  });

  test("ROLLBACK does not erase the read log", () => {
    db.beginTracking();
    db.exec("BEGIN;");
    db.exec("UPDATE users SET age=999 WHERE id=1;");
    db.exec("ROLLBACK;");
    // age is back to 30 but the fact that we *read* row 1 is still in the log.
    const log = db.getReadLog();
    expect(log.some(r => r.table === "users" && r.rowid === 1)).toBe(true);
    const age = db.exec("SELECT age FROM users WHERE id=1")[0].values[0][0];
    expect(age).toBe(30);
  });
});

describe("resetTracking and begin-again semantics", () => {
  test("resetTracking clears logs but leaves tracking enabled", () => {
    db.beginTracking();
    db.exec("SELECT * FROM users");
    expect(db.getReadLog().length).toBeGreaterThan(0);
    db.resetTracking();
    expect(db.getReadLog()).toHaveLength(0);
    expect(db.getQueryLog()).toHaveLength(0);
    expect(db.isTracking()).toBe(true);
    db.exec("SELECT * FROM users WHERE id=2");
    expect(db.getReadLog()).toEqual([
      { table: "users", rowid: 2, query: 0 },
    ]);
  });

  test("calling beginTracking again resets logs", () => {
    db.beginTracking();
    db.exec("SELECT * FROM users");
    db.beginTracking();
    expect(db.getReadLog()).toHaveLength(0);
    db.exec("SELECT * FROM users WHERE id=1");
    expect(db.getReadLog().map(r => r.rowid)).toEqual([1]);
  });
});

describe("dumpTracking JSON shape", () => {
  test("returns a parseable document with reads and queries arrays", () => {
    db.beginTracking();
    db.exec("SELECT id FROM users WHERE id=2");
    const doc = JSON.parse(db.dumpTracking());
    expect(Array.isArray(doc.reads)).toBe(true);
    expect(Array.isArray(doc.queries)).toBe(true);
    expect(doc.reads[0]).toMatchObject({ table: "users", rowid: 2 });
    expect(doc.queries[0]).toMatchObject({ sql: expect.stringContaining("SELECT") });
  });
});
