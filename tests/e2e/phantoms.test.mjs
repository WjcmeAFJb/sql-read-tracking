/**
 * Phantom-detection E2E: reconstruct scanned ranges from the predicate
 * log and check that a concurrent index-write falling in those ranges
 * surfaces as an rw-dependency -- the class of conflict that point-read
 * tracking alone cannot see.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import initSqliteTracked from "../../dist/sqlite3-tracked.mjs";

let SQL;
beforeAll(async () => { SQL = await initSqliteTracked(); });

let db;
beforeEach(() => {
  db = new SQL.Database();
  db.exec(`
    CREATE TABLE posts(id INTEGER PRIMARY KEY, user_id INT, body TEXT);
    CREATE INDEX posts_user ON posts(user_id);
    INSERT INTO posts VALUES(10,1,'hi'),(11,2,'yo');
  `);
});
afterEach(() => { db.close(); });

/**
 * Pair up a predicate log into ranges. Each consecutive 's' -> 'e' pair
 * for the same table and query defines a closed interval; a lone 's'
 * means "range opened, no terminator" (e.g. SeekRowid miss, or a scan
 * to EOF) and we treat it as unbounded on that side.
 */
function reconstructRanges(preds) {
  const out = [];
  let pending = null;
  for(const p of preds){
    if( p.kind === "s" ){
      if( pending ){ out.push({ ...pending, high: null }); }
      pending = {
        table: p.table, query: p.query,
        low: p.key, lowIncl: p.op === "G" || p.op === "L",
        lowDir: p.op === "G" || p.op === "g" ? "asc" : "desc",
      };
    } else if( p.kind === "e" && pending && pending.table === p.table ){
      out.push({
        ...pending,
        high: p.key,
        highIncl: p.op === "L" || p.op === "g", // IdxGT excl-exit means incl-scan
      });
      pending = null;
    }
  }
  if( pending ) out.push({ ...pending, high: null });
  return out;
}

function keyIn(writeKey, range) {
  // Compare on the first key field (the indexed column); ignore trailing
  // rowid. Both writeKey and range.low/high are arrays.
  const v = writeKey[0];
  const lo = range.low ? range.low[0] : null;
  const hi = range.high ? range.high[0] : null;
  const cmpLo = lo === null ? 1 : (v < lo ? -1 : v > lo ? 1 : 0);
  const cmpHi = hi === null ? -1 : (v < hi ? -1 : v > hi ? 1 : 0);
  if( lo !== null ){
    if( cmpLo < 0 ) return false;
    if( cmpLo === 0 && !range.lowIncl ) return false;
  }
  if( hi !== null ){
    if( cmpHi > 0 ) return false;
    if( cmpHi === 0 && !range.highIncl ) return false;
  }
  return true;
}

describe("Predicate log: equality lookup emits a closed range", () => {
  test("SELECT ... WHERE user_id=1 records [1..1] on posts", () => {
    db.beginTracking();
    db.exec("SELECT id FROM posts WHERE user_id=1");
    const preds = db.getPredicateLog();
    // Expect at least a seek + terminator pair on posts.
    const onPosts = preds.filter(p => p.table === "posts");
    const kinds = onPosts.map(p => p.kind);
    expect(kinds).toContain("s");
    expect(kinds).toContain("e");
    const ranges = reconstructRanges(onPosts);
    // At least one range; its low/high key[0] should both be 1.
    expect(ranges.length).toBeGreaterThanOrEqual(1);
    const r = ranges.find(r => r.low && r.low[0] === 1);
    expect(r).toBeTruthy();
    expect(r.low[0]).toBe(1);
    expect(r.high[0]).toBe(1);
  });

  test("empty-result lookup still records the range", () => {
    /* This is the phantom-critical case: no rows matched, but we still
    ** logged the predicate we probed -- so a later INSERT of a matching
    ** row will be detectable as an rw-conflict. */
    db.beginTracking();
    db.exec("SELECT id FROM posts WHERE user_id=99"); // no rows
    const preds = db.getPredicateLog();
    const onPosts = preds.filter(p => p.table === "posts");
    expect(onPosts.some(p => p.kind === "s")).toBe(true);
    // A seek with no match may or may not emit a terminator; either way
    // the seek key of 99 must be present.
    const seek = onPosts.find(p => p.kind === "s");
    expect(seek.key[0]).toBe(99);
  });
});

describe("Index-write log: INSERT captures the indexed key", () => {
  test("INSERT emits an indexwrite event with the user_id value", () => {
    db.beginTracking();
    db.exec("INSERT INTO posts VALUES(12, 1, 'phantom-row')");
    const log = db.getIndexWriteLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      table: "posts",
      op: "insert",
      rowid: 12,
    });
    // key[0] is user_id=1; key[1] is rowid=12 (appended by SQLite).
    expect(log[0].key[0]).toBe(1);
    expect(log[0].key[1]).toBe(12);
  });
});

describe("Phantom conflict detection end-to-end", () => {
  test("T1 reads user_id=1 (empty via user_id=99); T2 inserts user_id=99 -> conflict", () => {
    /* T1: scan for user_id=99 -- no rows. */
    db.beginTracking();
    db.exec("SELECT id FROM posts WHERE user_id=99");
    const t1Preds = db.getPredicateLog().filter(p => p.table === "posts");
    const t1Ranges = reconstructRanges(t1Preds);
    db.endTracking();
    db.resetTracking();

    /* T2: insert a row with user_id=99 -- a phantom with respect to T1. */
    db.beginTracking();
    db.exec("INSERT INTO posts VALUES(99, 99, 'surprise')");
    const t2IdxWrites = db.getIndexWriteLog().filter(w => w.table === "posts");
    db.endTracking();

    /* Check: does any T2 index-write fall inside any T1 range? */
    let conflict = false;
    for(const w of t2IdxWrites){
      for(const r of t1Ranges){
        if( keyIn(w.key, r) ){ conflict = true; break; }
      }
      if( conflict ) break;
    }
    expect(conflict).toBe(true);
  });

  test("disjoint predicates do NOT produce false conflicts", () => {
    db.beginTracking();
    db.exec("SELECT id FROM posts WHERE user_id=1");
    const t1Ranges = reconstructRanges(
      db.getPredicateLog().filter(p => p.table === "posts")
    );
    db.resetTracking();

    /* T2 writes user_id=7 (outside T1's [1..1] range). */
    db.beginTracking();
    db.exec("INSERT INTO posts VALUES(30, 7, 'unrelated')");
    const t2IdxWrites = db.getIndexWriteLog().filter(w => w.table === "posts");
    db.endTracking();

    const conflict = t2IdxWrites.some(w => t1Ranges.some(r => keyIn(w.key, r)));
    expect(conflict).toBe(false);
  });

  test("range predicate catches a phantom inside BETWEEN", () => {
    /* Seed a matching row so OP_SeekGE succeeds and OP_IdxGT fires --
    ** that is what records the upper bound. See the "empty-range"
    ** conservatism test below for the counter-case. */
    db.exec("INSERT INTO posts VALUES(20, 8, 'anchor in range')");
    db.beginTracking();
    db.exec("SELECT id FROM posts WHERE user_id BETWEEN 5 AND 20");
    const t1Ranges = reconstructRanges(
      db.getPredicateLog().filter(p => p.table === "posts")
    );
    db.resetTracking();

    /* T2 inserts a user_id=10, inside T1's range. */
    db.beginTracking();
    db.exec("INSERT INTO posts VALUES(40, 10, 'phantom in the middle')");
    const t2IdxWrites = db.getIndexWriteLog().filter(w => w.table === "posts");
    db.endTracking();

    const conflict = t2IdxWrites.some(w => t1Ranges.some(r => keyIn(w.key, r)));
    expect(conflict).toBe(true);
  });

  test("range predicate does NOT catch a write outside the range", () => {
    db.exec("INSERT INTO posts VALUES(20, 8, 'anchor in range')");
    db.beginTracking();
    db.exec("SELECT id FROM posts WHERE user_id BETWEEN 5 AND 20");
    const t1Ranges = reconstructRanges(
      db.getPredicateLog().filter(p => p.table === "posts")
    );
    db.resetTracking();

    db.beginTracking();
    db.exec("INSERT INTO posts VALUES(41, 100, 'above the range')");
    const t2IdxWrites = db.getIndexWriteLog().filter(w => w.table === "posts");
    db.endTracking();

    const conflict = t2IdxWrites.some(w => t1Ranges.some(r => keyIn(w.key, r)));
    expect(conflict).toBe(false);
  });

  test("empty-range scan is conservative: upper bound is NOT recorded", () => {
    /* When SELECT ... BETWEEN x AND y matches no rows, SQLite's SeekGE
    ** jumps straight to the loop exit and never executes the IdxGT
    ** that carries the upper bound in its register. Our log therefore
    ** lacks the 'e' event, and the reconstructed range is unbounded
    ** above. This is sound for SSI (no conflicts missed) but produces
    ** false positives: a write at user_id=999 looks like a phantom
    ** relative to "BETWEEN 5 AND 20" even though the intent never
    ** covered that key. Documented here so consumers know to either
    ** tolerate the over-abort rate or combine point-read evidence to
    ** narrow ranges. */
    db.beginTracking();
    db.exec("SELECT id FROM posts WHERE user_id BETWEEN 5 AND 20");
    const preds = db.getPredicateLog().filter(p => p.table === "posts");
    const kinds = preds.map(p => p.kind);
    expect(kinds).toContain("s");
    expect(kinds).not.toContain("e"); // documents the limitation
  });
});
