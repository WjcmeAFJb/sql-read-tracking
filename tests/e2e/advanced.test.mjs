/**
 * Advanced E2E scenarios: prepared statements with bindings, aggregates,
 * GROUP BY, DISTINCT, self-joins, recursive CTEs, triggers, views, and
 * blob round-tripping.
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
    CREATE TABLE orders(id INTEGER PRIMARY KEY, user_id INT, amount REAL);
    CREATE INDEX orders_user ON orders(user_id);
    INSERT INTO users VALUES
      (1,'alice',30),(2,'bob',40),(3,'carol',25),(4,'dave',35);
    INSERT INTO orders VALUES
      (100,1, 9.99),(101,1, 1.00),(102,2,50.00),(103,2,25.00),
      (104,3, 5.00),(105,4,10.00);
  `);
});
afterEach(() => { db.close(); });

describe("Prepared statements", () => {
  test("bind positional params", () => {
    const s = db.prepare("SELECT name FROM users WHERE id=?");
    s.bind([2]);
    const row = s.get();
    expect(row).toEqual(["bob"]);
    s.free();
  });

  test("bind named params with :prefix", () => {
    const s = db.prepare("SELECT age FROM users WHERE name=:n");
    const obj = s.getAsObject({ n: "carol" });
    expect(obj).toEqual({ age: 25 });
    s.free();
  });

  test("prepared statement reads are tracked", () => {
    db.beginTracking();
    const s = db.prepare("SELECT name FROM users WHERE id=?");
    s.bind([3]); s.step(); s.free();
    const log = db.getReadLog();
    expect(log.some(r => r.table === "users" && r.rowid === 3)).toBe(true);
  });
});

describe("Aggregates and grouping", () => {
  test("COUNT(*) is a fast-path: row data is NOT tracked", () => {
    /* Documenting a known quirk: SQLite's planner turns SELECT COUNT(*)
    ** into OP_Count against the btree metadata -- no OP_Column fires --
    ** so no per-row reads surface. Applications that need per-row
    ** tracking of a table-count operation must force a scan by counting
    ** a non-NULL column instead. */
    db.beginTracking();
    const r = db.exec("SELECT COUNT(*) FROM users")[0].values[0][0];
    expect(r).toBe(4);
    expect(db.getReadLog().filter(x=>x.table==="users")).toEqual([]);
  });

  test("SUM over a column DOES scan and track every row", () => {
    db.beginTracking();
    db.exec("SELECT SUM(age) FROM users");
    const rids = db.getReadLog().filter(x=>x.table==="users").map(x=>x.rowid);
    expect(rids.sort()).toEqual([1,2,3,4]);
  });

  test("GROUP BY tracks every input row", () => {
    db.beginTracking();
    const r = db.exec("SELECT user_id, SUM(amount) FROM orders GROUP BY user_id");
    expect(r[0].values.length).toBe(4);
    const rids = db.getReadLog().filter(x=>x.table==="orders").map(x=>x.rowid);
    expect(rids.sort()).toEqual([100,101,102,103,104,105]);
  });

  test("HAVING narrows output but input rows are still tracked", () => {
    db.beginTracking();
    db.exec(`
      SELECT user_id FROM orders
      GROUP BY user_id HAVING SUM(amount) > 30
    `);
    // All 6 orders rows were scanned to compute the aggregate.
    const rids = db.getReadLog().filter(x=>x.table==="orders").map(x=>x.rowid);
    expect(rids.sort()).toEqual([100,101,102,103,104,105]);
  });
});

describe("Correlated subqueries and EXISTS", () => {
  test("EXISTS correlated on user_id tracks both tables", () => {
    db.beginTracking();
    db.exec(`
      SELECT u.name FROM users u
      WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id AND o.amount>20)
    `);
    const log = db.getReadLog();
    const users = log.filter(r=>r.table==="users").map(r=>r.rowid);
    expect(users.sort()).toEqual([1,2,3,4]);
    const orders = log.filter(r=>r.table==="orders").map(r=>r.rowid);
    // Each user was probed against orders; matches drive the tracking.
    expect(orders.length).toBeGreaterThan(0);
  });

  test("scalar subquery in SELECT list is tracked", () => {
    db.beginTracking();
    db.exec(`
      SELECT u.name, (SELECT MAX(amount) FROM orders WHERE user_id=u.id) m
      FROM users u
    `);
    // All 4 users plus all orders touched.
    const users = db.getReadLog().filter(r=>r.table==="users").length;
    const orders = db.getReadLog().filter(r=>r.table==="orders").length;
    expect(users).toBeGreaterThanOrEqual(4);
    expect(orders).toBeGreaterThanOrEqual(1);
  });
});

describe("Recursive CTEs", () => {
  test("recursive CTE over a hierarchy", () => {
    db.exec(`
      CREATE TABLE nodes(id INTEGER PRIMARY KEY, parent INT);
      INSERT INTO nodes VALUES(1,NULL),(2,1),(3,1),(4,2),(5,4);
    `);
    db.beginTracking();
    const res = db.exec(`
      WITH RECURSIVE walk(id, lvl) AS (
        SELECT id, 0 FROM nodes WHERE id=1
        UNION ALL
        SELECT n.id, w.lvl+1 FROM nodes n JOIN walk w ON n.parent=w.id
      )
      SELECT id FROM walk ORDER BY lvl, id
    `);
    expect(res[0].values.map(r=>r[0])).toEqual([1,2,3,4,5]);
    // Every node row should show up in the read log.
    const rids = db.getReadLog().filter(r=>r.table==="nodes").map(r=>r.rowid);
    expect(rids.sort()).toEqual([1,2,3,4,5]);
  });
});

describe("Triggers", () => {
  test("BEFORE INSERT trigger's reads are tracked", () => {
    db.exec(`
      CREATE TABLE audit(id INTEGER PRIMARY KEY, note TEXT);
      CREATE TRIGGER trg_before_insert BEFORE INSERT ON users
      BEGIN
        INSERT INTO audit(note) SELECT name FROM users;
      END;
    `);
    db.beginTracking();
    db.exec("INSERT INTO users VALUES(99,'eve',22)");
    /* The trigger scanned users row-by-row (SELECT name FROM users).
    ** COUNT(*) would *not* trigger per-row reads because SQLite's
    ** OP_Count uses btree metadata, not OP_Column. */
    const rids = db.getReadLog().filter(r=>r.table==="users").map(r=>r.rowid);
    expect(rids.length).toBeGreaterThanOrEqual(4);
  });
});

describe("Views", () => {
  test("querying a view tracks reads on the underlying tables", () => {
    db.exec("CREATE VIEW adult_users AS SELECT * FROM users WHERE age>=30");
    db.beginTracking();
    db.exec("SELECT name FROM adult_users WHERE age<40");
    const rids = db.getReadLog().filter(r=>r.table==="users").map(r=>r.rowid).sort();
    expect(rids).toEqual([1,2,3,4]);
  });
});

describe("DISTINCT and UNION", () => {
  test("UNION tracks both branches", () => {
    db.beginTracking();
    db.exec(`
      SELECT id FROM users WHERE age>30
      UNION
      SELECT user_id FROM orders WHERE amount>20
    `);
    expect(db.getReadLog().some(r=>r.table==="users")).toBe(true);
    expect(db.getReadLog().some(r=>r.table==="orders")).toBe(true);
  });
});

describe("Blob values", () => {
  test("round-trip a Uint8Array through bind and column", () => {
    db.exec("CREATE TABLE blobs(id INTEGER PRIMARY KEY, data BLOB)");
    const payload = new Uint8Array([0x00, 0x10, 0xff, 0x7f, 0x80]);
    const s = db.prepare("INSERT INTO blobs VALUES(1, ?)");
    s.bind([payload]);
    s.step();
    s.free();
    db.beginTracking();
    const back = db.exec("SELECT data FROM blobs WHERE id=1")[0].values[0][0];
    expect(back instanceof Uint8Array).toBe(true);
    expect(Array.from(back)).toEqual(Array.from(payload));
    // Tracking worked too
    expect(db.getReadLog()).toEqual([
      { table: "blobs", rowid: 1, query: 0 },
    ]);
  });
});

describe("Dedup behavior", () => {
  test("multi-column SELECT of same row emits ONE read", () => {
    db.beginTracking();
    db.exec("SELECT id, name, age FROM users WHERE id=1");
    const forId1 = db.getReadLog().filter(r=>r.table==="users" && r.rowid===1);
    expect(forId1).toHaveLength(1);
  });

  test("same row accessed via index and table yields ONE entry", () => {
    db.beginTracking();
    db.exec(`
      SELECT u.name, o.amount FROM users u, orders o
      WHERE o.user_id=u.id AND u.id=1
    `);
    /* The join probes posts_user index, then seeks to orders rows, then
    ** reads columns. Each unique (table, rowid) should appear once. */
    const users = db.getReadLog().filter(r=>r.table==="users" && r.rowid===1);
    expect(users).toHaveLength(1);
    const ordersReads = db.getReadLog().filter(r=>r.table==="orders");
    // alice has 2 orders (100, 101).
    expect(ordersReads.map(r=>r.rowid).sort()).toEqual([100, 101]);
  });
});

describe("Multiple databases isolation", () => {
  test("tracking on db1 doesn't affect db2", () => {
    const db2 = new SQL.Database();
    db2.exec("CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES(99);");
    db.beginTracking();
    db2.exec("SELECT * FROM t");
    db.exec("SELECT * FROM users WHERE id=1");
    expect(db.getReadLog().some(r=>r.table==="t")).toBe(false);
    expect(db.getReadLog().some(r=>r.table==="users")).toBe(true);
    expect(db2.getReadLog()).toEqual([]); // db2 never had tracking enabled
    db2.close();
  });
});

describe("Error handling", () => {
  test("SQL syntax errors throw and do not corrupt tracking state", () => {
    db.beginTracking();
    expect(() => db.exec("SELECT oops FROM nonexistent")).toThrow();
    // A previous successful query should still be loggable.
    db.exec("SELECT id FROM users WHERE id=1");
    expect(db.getReadLog().some(r=>r.table==="users" && r.rowid===1)).toBe(true);
  });
});
