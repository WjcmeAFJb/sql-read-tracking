/**
 * Write-log E2E coverage. The C-level suite already checks VDBE
 * completeness; these tests verify the JS surface and shape callers
 * rely on, plus document the rw-graph use-case end-to-end.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import initSqliteTracked from "../../dist/sqlite3-tracked.js";

let SQL;
beforeAll(async () => { SQL = await initSqliteTracked(); });

let db;
beforeEach(() => {
  db = new SQL.Database();
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, age INT);
    CREATE TABLE posts(id INTEGER PRIMARY KEY, user_id INT, body TEXT);
    CREATE INDEX posts_user ON posts(user_id);
    INSERT INTO users VALUES(1,'alice',30),(2,'bob',40),(3,'carol',25);
    INSERT INTO posts VALUES(10,1,'hi'),(11,1,'hello'),(12,2,'howdy'),(13,3,'hey');
  `);
});
afterEach(() => { db.close(); });

describe("Write log: basic ops", () => {
  test("INSERT produces one 'insert' entry", () => {
    db.beginTracking();
    db.exec("INSERT INTO users VALUES(4,'dave',50)");
    expect(db.getWriteLog()).toEqual([
      { table: "users", rowid: 4, op: "insert", query: 0 },
    ]);
  });

  test("UPDATE produces a single 'update' entry with the same rowid", () => {
    /* SQLite's planner emits OP_Insert+ISUPDATE for simple UPDATEs on
    ** rowid tables, so we expect one "update" event, not delete+insert. */
    db.beginTracking();
    db.exec("UPDATE users SET age=31 WHERE id=1");
    const writes = db.getWriteLog();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      table: "users", rowid: 1, op: "update",
    });
  });

  test("DELETE with a WHERE clause emits per-row 'delete' entries", () => {
    db.beginTracking();
    db.exec("DELETE FROM posts WHERE user_id=1");
    const writes = db.getWriteLog().filter(w => w.table === "posts");
    expect(writes.map(w => w.rowid).sort()).toEqual([10, 11]);
    expect(writes.every(w => w.op === "delete")).toBe(true);
  });
});

describe("Write log: paths sqlite3_update_hook would miss", () => {
  test("DELETE FROM t (truncate optimization) records a wildcard 'truncate'", () => {
    /* DELETE without a WHERE goes through OP_Clear -- sqlite3_update_hook
    ** never fires. We log a rowid=-1 wildcard so rw-graph checkers can
    ** treat it as conflicting with any concurrent read on `posts`. */
    db.beginTracking();
    db.exec("DELETE FROM posts");
    const writes = db.getWriteLog();
    expect(writes).toEqual([
      { table: "posts", rowid: -1, op: "truncate", query: 0 },
    ]);
    expect(db.exec("SELECT COUNT(*) FROM posts")[0].values[0][0]).toBe(0);
  });

  test("INSERT OR REPLACE catches the inline conflict delete", () => {
    /* REPLACE-conflict deletion skips update_hook; VDBE hooks catch it. */
    db.exec("CREATE UNIQUE INDEX users_name ON users(name)");
    db.beginTracking();
    db.exec("INSERT OR REPLACE INTO users(id,name,age) VALUES(99,'alice',77)");
    const writes = db.getWriteLog();
    // Expect a 'delete' of the conflicting row (rowid=1) and an
    // 'insert' of rowid=99.
    expect(writes.some(w => w.op === "delete" && w.rowid === 1)).toBe(true);
    expect(writes.some(w => w.op === "insert" && w.rowid === 99)).toBe(true);
  });
});

describe("Write log: attribution and isolation", () => {
  test("each write's `query` points at the originating statement", () => {
    db.beginTracking();
    db.exec("INSERT INTO users VALUES(5,'eve',18)");
    db.exec("DELETE FROM users WHERE id=3");
    const writes = db.getWriteLog();
    expect(writes).toHaveLength(2);
    expect(writes[0].query).toBe(0);
    expect(writes[1].query).toBe(1);
    const queries = db.getQueryLog();
    expect(queries[writes[0].query].sql).toMatch(/INSERT/);
    expect(queries[writes[1].query].sql).toMatch(/DELETE/);
  });

  test("ROLLBACK does not retract write-log entries", () => {
    /* The log is an intent history: rollback unwinds the DB, but
    ** rw-graph detection operates on *attempted* writes. */
    db.beginTracking();
    db.exec("BEGIN");
    db.exec("INSERT INTO users VALUES(42,'temp',0)");
    db.exec("ROLLBACK");
    expect(db.getWriteLog().some(w => w.rowid === 42 && w.op === "insert")).toBe(true);
    expect(db.exec("SELECT COUNT(*) FROM users WHERE id=42")[0].values[0][0]).toBe(0);
  });

  test("tracking disabled -> no writes recorded", () => {
    db.exec("INSERT INTO users VALUES(6,'fran',60)");
    expect(db.getWriteLog()).toEqual([]);
  });
});

describe("Write log: ergonomic rw-graph check", () => {
  /* Demonstrate how a consumer would build an rw-dependency graph from
  ** two transactions' logs to detect serializability violations. */
  function readSet(db) {
    const rs = new Set();
    for(const r of db.getReadLog()){
      rs.add(`${r.table}:${r.rowid}`);
    }
    return rs;
  }
  function writeSet(db) {
    const ws = [];
    for(const w of db.getWriteLog()) ws.push(w);
    return ws;
  }
  function hasConflict(readSet, writes) {
    for(const w of writes){
      if( w.op === "truncate" ){
        // wildcard matches any read on this table
        for(const r of readSet){
          if( r.startsWith(w.table + ":") ) return true;
        }
      } else {
        if( readSet.has(`${w.table}:${w.rowid}`) ) return true;
      }
    }
    return false;
  }

  test("rw-dependency: T2 updates a row T1 read", () => {
    const db2 = new SQL.Database();
    db2.exec(`
      CREATE TABLE users(id INTEGER PRIMARY KEY, age INT);
      INSERT INTO users VALUES(1,30),(2,40);
    `);
    db2.beginTracking();
    db2.exec("SELECT age FROM users WHERE id=1");
    const t1Reads = readSet(db2);
    db2.endTracking();
    db2.resetTracking();

    db2.beginTracking();
    db2.exec("UPDATE users SET age=31 WHERE id=1");
    const t2Writes = writeSet(db2);
    db2.endTracking();

    expect(hasConflict(t1Reads, t2Writes)).toBe(true);
    db2.close();
  });

  test("rw-dependency: T2 truncates a table T1 read", () => {
    const db2 = new SQL.Database();
    db2.exec(`
      CREATE TABLE users(id INTEGER PRIMARY KEY);
      INSERT INTO users VALUES(1),(2);
    `);
    db2.beginTracking();
    db2.exec("SELECT id FROM users WHERE id=1");
    const t1Reads = readSet(db2);
    db2.resetTracking();

    db2.exec("DELETE FROM users"); // truncate optimization
    const t2Writes = writeSet(db2);

    expect(hasConflict(t1Reads, t2Writes)).toBe(true);
    db2.close();
  });

  test("no conflict: disjoint rowids", () => {
    db.beginTracking();
    db.exec("SELECT name FROM users WHERE id=1");
    const t1Reads = readSet(db);
    db.resetTracking();

    db.exec("UPDATE users SET age=age+1 WHERE id=2");
    const t2Writes = writeSet(db);

    expect(hasConflict(t1Reads, t2Writes)).toBe(false);
  });
});

describe("dumpTracking includes writes", () => {
  test("writes appear in the JSON document alongside reads and queries", () => {
    db.beginTracking();
    db.exec("INSERT INTO users VALUES(7,'gina',20)");
    db.exec("SELECT id FROM users WHERE id=7");
    const doc = JSON.parse(db.dumpTracking());
    expect(Array.isArray(doc.writes)).toBe(true);
    expect(doc.writes).toEqual([
      { table: "users", rowid: 7, op: "I", query: 0 },
    ]);
    expect(doc.reads.some(r => r.table === "users" && r.rowid === 7)).toBe(true);
  });
});
