/**
 * cluster-demo.mjs -- Given two *branches* of SQL (each branch is a
 * sequence of transactions applied in order starting from the same
 * snapshot), find the clusters of transactions from both branches
 * that must be serialised together, and those that commute freely so
 * they can be rebased without interaction.
 *
 * The idea mirrors a git rebase: branch A and branch B diverged from
 * a common base. To merge them into one linear history you need to
 * know which transactions from each side touch the same data.
 *
 *   - A cluster containing txs from only branch A can be rebased
 *     anywhere in branch B's history without affecting it.
 *   - A cluster containing txs from only branch B can be rebased
 *     anywhere in branch A's history without affecting it.
 *   - A cluster containing txs from BOTH branches is an interaction
 *     point: the within-branch order constrains each side, and the
 *     rw/ww/phantom edges constrain the cross-branch relation.
 *
 * Method:
 *   1. Each tx runs against a fresh snapshot (so the captured
 *      read/write/predicate/index-write logs describe the tx's
 *      *intended* operations starting from the pre-rebase state).
 *   2. We build a conflict graph over *all* transactions from both
 *      branches using four conflict kinds: point-rw, point-ww,
 *      truncate-vs-anything, and phantom (predicate-range × index-write).
 *   3. Union-find gives connected components. Each component is
 *      classified as A-only, B-only, or MIXED based on which
 *      branches' txs it contains.
 */
import initSqliteTracked from "../dist/sqlite3-tracked.js";

const SQL = await initSqliteTracked();

/* ---------------------------- tracking ---------------------------- */

function runAndTrack(seed, tx) {
  const db = new SQL.Database();
  seed(db);
  db.beginTracking();
  let ok = true, err = null;
  try {
    db.exec(tx.sql);
  } catch (e) {
    ok = false;
    err = e.message;
  }
  db.endTracking();
  const out = {
    label: tx.label,
    branch: tx.branch,
    indexInBranch: tx.indexInBranch,
    sql: tx.sql,
    ok, err,
    reads: db.getReadLog(),
    writes: db.getWriteLog(),
    preds: db.getPredicateLog(),
    idxWrites: db.getIndexWriteLog(),
  };
  db.close();
  return out;
}

/* --------------------------- predicates --------------------------- */

function reconstructRanges(preds) {
  const out = [];
  let pending = null;
  for (const p of preds) {
    if (p.kind === "s") {
      if (pending) out.push({ ...pending, high: null });
      pending = {
        table: p.table,
        index: p.index,      // carries forward so phantom match is index-specific
        low: p.key,
        lowIncl: p.op === "G" || p.op === "L",
      };
    } else if (p.kind === "e" && pending && pending.table === p.table
               && pending.index === p.index) {
      out.push({
        ...pending,
        high: p.key,
        highIncl: p.op === "L" || p.op === "g",
      });
      pending = null;
    } else if (p.kind === "r") {
      out.push({
        table: p.table, index: p.index,
        low: null, high: null, lowIncl: true, highIncl: true,
      });
    }
  }
  if (pending) out.push({ ...pending, high: null });
  return out;
}

function keyInRange(writeKey, range) {
  const v = writeKey[0];
  if (range.low !== null) {
    const lo = range.low[0];
    if (v < lo) return false;
    if (v === lo && range.lowIncl === false) return false;
  }
  if (range.high !== null) {
    const hi = range.high[0];
    if (v > hi) return false;
    if (v === hi && range.highIncl === false) return false;
  }
  return true;
}

/* --------------------------- conflicts ---------------------------- */

function conflictReasons(a, b) {
  const reasons = [];

  /* Pre-compute the set of (table, rowid) pairs where both txs do
   * column-disjoint UPDATEs. Those pairs commute -- physically both
   * rewrite the whole row, so the row-level tracker flags rw+ww, but
   * semantically each side preserves the other's columns on rewrite
   * and the final state is the same regardless of order. We suppress
   * edges on those rows so the cluster graph doesn't merge them. The
   * suppression assumes SET expressions don't cross-reference (i.e.
   * neither side's SET formula reads a column the other side writes);
   * that is the common case for independent column updates. */
  const commuting = new Set();
  for (const wa of a.writes) {
    if (wa.op !== "update" || !wa.columns) continue;
    for (const wb of b.writes) {
      if (wb.op !== "update" || !wb.columns) continue;
      if (wa.table !== wb.table || wa.rowid !== wb.rowid) continue;
      const sa = new Set(wa.columns);
      if (!wb.columns.some(c => sa.has(c))) {
        commuting.add(`${wa.table}:${wa.rowid}`);
      }
    }
  }
  const isCommuting = (table, rowid) => commuting.has(`${table}:${rowid}`);

  const pointRW = (reader, writer) => {
    for (const w of writer.writes) {
      if (w.op === "truncate") {
        const hit = reader.reads.find(r => r.table === w.table);
        if (hit) reasons.push(
          `rw: ${reader.label} read ${hit.table}:${hit.rowid}; ` +
          `${writer.label} truncated ${w.table}`
        );
      } else {
        if (isCommuting(w.table, w.rowid)) continue;
        const hit = reader.reads.find(
          r => r.table === w.table && r.rowid === w.rowid
        );
        if (hit) reasons.push(
          `rw: ${reader.label} read ${hit.table}:${hit.rowid}; ` +
          `${writer.label} ${w.op} ${w.table}:${w.rowid}`
        );
      }
    }
  };
  pointRW(a, b);
  pointRW(b, a);

  /* ww conflict: same table AND same rowid AND overlapping column sets.
   * Two UPDATEs on the same row that touch disjoint columns commute,
   * so we suppress the ww edge in that case. Insert/delete/truncate
   * affect the whole row and thus conflict with any column set. */
  for (const wa of a.writes) {
    for (const wb of b.writes) {
      if (wa.table !== wb.table) continue;
      const rowOverlap =
        wa.op === "truncate" || wb.op === "truncate" || wa.rowid === wb.rowid;
      if (!rowOverlap) continue;

      /* If both are updates with known column sets, require column overlap. */
      if (wa.op === "update" && wb.op === "update"
          && wa.columns && wb.columns) {
        const sa = new Set(wa.columns);
        const shared = wb.columns.filter(c => sa.has(c));
        if (shared.length === 0) continue;
        reasons.push(
          `ww: ${a.label} UPDATE ${wa.table}:${wa.rowid} cols=[${wa.columns.join(",")}]; ` +
          `${b.label} UPDATE ${wb.table}:${wb.rowid} cols=[${wb.columns.join(",")}] ` +
          `-- shared columns: {${shared.join(",")}}`
        );
      } else {
        const colsA = wa.columns ? ` cols=[${wa.columns.join(",")}]` : "";
        const colsB = wb.columns ? ` cols=[${wb.columns.join(",")}]` : "";
        reasons.push(
          `ww: ${a.label} ${wa.op} ${wa.table}:${wa.rowid}${colsA}; ` +
          `${b.label} ${wb.op} ${wb.table}:${wb.rowid}${colsB}`
        );
      }
      break;
    }
  }

  const phantom = (scanner, inserter) => {
    const ranges = reconstructRanges(scanner.preds);
    for (const r of ranges) {
      for (const iw of inserter.idxWrites) {
        /* Phantom conflict only if the range and the index-write are
         * on the SAME table AND the SAME index. An orders_user range
         * scan has nothing to say about an orders_status insert key. */
        if (iw.table !== r.table) continue;
        if ((iw.index || null) !== (r.index || null)) continue;
        if (keyInRange(iw.key, r)) {
          const where = r.index ? `${r.table}.${r.index}` : r.table;
          reasons.push(
            `phantom: ${scanner.label} scanned ${where}` +
            `[${JSON.stringify(r.low)}..${JSON.stringify(r.high)}]; ` +
            `${inserter.label} ${iw.op} key ${JSON.stringify(iw.key)}`
          );
        }
      }
    }
  };
  phantom(a, b);
  phantom(b, a);

  return reasons;
}

/* ---------------------------- clustering --------------------------- */

function clusterTxs(txs) {
  const parent = txs.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };

  const edges = [];
  for (let i = 0; i < txs.length; i++) {
    for (let j = i + 1; j < txs.length; j++) {
      const reasons = conflictReasons(txs[i], txs[j]);
      if (reasons.length > 0) {
        edges.push({ i, j, reasons });
        union(i, j);
      }
    }
  }

  const clusters = new Map();
  for (let i = 0; i < txs.length; i++) {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(i);
  }
  return { clusters: [...clusters.values()], edges };
}

/* --------------------- reporting -------------------------------- */

function classify(cluster, txs) {
  const branches = new Set(cluster.map(i => txs[i].branch));
  if (branches.size === 1) return [...branches][0] + "-only";
  return "MIXED";
}

function report(title, seed, branchA, branchB) {
  console.log("\n" + "=".repeat(74));
  console.log(`  ${title}`);
  console.log("=".repeat(74));

  const tagged = [
    ...branchA.map((tx, i) => ({ ...tx, branch: "A", indexInBranch: i, label: `A${i + 1}` })),
    ...branchB.map((tx, i) => ({ ...tx, branch: "B", indexInBranch: i, label: `B${i + 1}` })),
  ];

  console.log("\nBranch A:");
  tagged.filter(t => t.branch === "A").forEach(t => {
    const q = t.sql.trim().replace(/\s+/g, " ");
    console.log(`  ${t.label.padEnd(3)}  ${q.length > 68 ? q.slice(0, 65) + "..." : q}`);
  });

  console.log("\nBranch B:");
  tagged.filter(t => t.branch === "B").forEach(t => {
    const q = t.sql.trim().replace(/\s+/g, " ");
    console.log(`  ${t.label.padEnd(3)}  ${q.length > 68 ? q.slice(0, 65) + "..." : q}`);
  });

  const tracked = tagged.map(tx => runAndTrack(seed, tx));

  const failed = tracked.filter(t => !t.ok);
  if (failed.length) {
    console.log("\nFailed to run:");
    for (const f of failed) console.log(`  ${f.label}: ${f.err}`);
  }

  const { clusters, edges } = clusterTxs(tracked);

  console.log("\nConflict edges:");
  if (edges.length === 0) {
    console.log("  (none -- everything commutes, the two branches are fully disjoint)");
  } else {
    for (const e of edges) {
      console.log(`  ${tracked[e.i].label} <-> ${tracked[e.j].label}`);
      for (const r of e.reasons) console.log(`      ${r}`);
    }
  }

  /* Sort clusters: MIXED first (interaction points), then single-branch
   * clusters by size (larger clusters likely more interesting). */
  const sorted = clusters
    .map(c => ({ indices: c, kind: classify(c, tracked) }))
    .sort((x, y) => {
      if (x.kind === "MIXED" && y.kind !== "MIXED") return -1;
      if (y.kind === "MIXED" && x.kind !== "MIXED") return 1;
      return y.indices.length - x.indices.length;
    });

  console.log("\nClusters:");
  sorted.forEach((c, i) => {
    const labels = c.indices.map(k => tracked[k].label).sort().join(", ");
    const annotation = c.kind === "MIXED"
      ? "INTERACTION -- must serialise carefully"
      : c.kind === "A-only"
        ? "A only -- can rebase into B freely"
        : "B only -- can rebase into A freely";
    console.log(`  #${i + 1} [${c.kind}]  { ${labels} }  (${annotation})`);
  });

  /* Suggest a merged serialisation order. For each MIXED cluster, the
   * relative order within a branch is preserved (A1 < A2 < ... and
   * B1 < B2 < ...); across branches we use first-seen ordering as a
   * cheap tiebreak. This is a suggestion only -- SSI would still have
   * to prove acyclicity on the directed version of the graph. */
  console.log("\nSuggested merged order (preserves within-branch order):");
  const merged = suggestOrder(tracked, sorted);
  console.log(`  ${merged.join(" -> ")}`);

  return { tracked, clusters: sorted, edges };
}

function suggestOrder(tracked, clusters) {
  /* Simple strategy: walk clusters in the order produced above, and
   * within each cluster emit the txs in (indexInBranch, branch) order.
   * That preserves the relative order inside each branch. */
  const out = [];
  for (const c of clusters) {
    const local = [...c.indices].sort((a, b) => {
      const ta = tracked[a], tb = tracked[b];
      if (ta.branch !== tb.branch) return ta.branch < tb.branch ? -1 : 1;
      return ta.indexInBranch - tb.indexInBranch;
    });
    for (const i of local) out.push(tracked[i].label);
  }
  return out;
}

/* ================================================================== */
/*                        SIMPLE DEMO                                 */
/* ================================================================== */

const seedSimple = (db) => {
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, age INT);
    CREATE TABLE posts(id INTEGER PRIMARY KEY, user_id INT, body TEXT);
    CREATE INDEX posts_user ON posts(user_id);
    INSERT INTO users VALUES(1,'alice',30),(2,'bob',40),(3,'carol',25);
    INSERT INTO posts VALUES(10,1,'hi'),(11,2,'yo'),(12,3,'hey');
  `);
};

/* Branch A: the "main" branch -- three unrelated admin operations. */
const simpleA = [
  { sql: "UPDATE users SET name='Alice' WHERE id=1" },
  { sql: "DELETE FROM posts WHERE id=11" },
  { sql: "UPDATE users SET age=age+1 WHERE id=3" },
];

/* Branch B: the "feature" branch. Four operations. Two of them touch
 * the same users row as branch A, but one of those only touches a
 * disjoint column (no conflict) and one touches the same column (real
 * conflict). The column-level write tracking is what lets us tell
 * those apart. */
const simpleB = [
  /* B1 touches users.1 but only the 'age' column -- column-disjoint
   * from A1's 'name' UPDATE, so these commute. */
  { sql: "UPDATE users SET age=25 WHERE id=1" },
  { sql: "INSERT INTO posts VALUES(50, 2, 'new')" },
  { sql: "SELECT body FROM posts WHERE user_id=3" },
  /* B4 touches users.1 'name' column -- same column as A1. Genuine ww
   * conflict; must serialise. */
  { sql: "UPDATE users SET name='Alicia' WHERE id=1" },
];

const simpleResult = report(
  "SIMPLE: two 3-tx branches, see which clusters carry cross-branch edges",
  seedSimple, simpleA, simpleB
);

/* ================================================================== */
/*                        COMPLEX DEMO                                */
/* ================================================================== */

const seedComplex = (db) => {
  db.exec(`
    CREATE TABLE users(
      id INTEGER PRIMARY KEY,
      name TEXT,
      tier TEXT DEFAULT 'silver'
    );
    CREATE TABLE orders(
      id INTEGER PRIMARY KEY,
      user_id INT,
      amount REAL,
      status TEXT
    );
    CREATE INDEX orders_user ON orders(user_id);
    CREATE INDEX orders_status ON orders(status);

    INSERT INTO users VALUES
      (1,'alice','silver'),
      (2,'bob','silver'),
      (3,'carol','silver'),
      (4,'dave','silver');
    INSERT INTO orders VALUES
      (100, 1,  9.99, 'active'),
      (101, 1,  1.00, 'active'),
      (102, 2, 50.00, 'active'),
      (103, 2, 25.00, 'canceled'),
      (104, 3,  5.00, 'canceled'),
      (105, 4, 10.00, 'active'),
      (106, 4,200.00, 'active');
  `);
};

/* Branch A -- reporting/analytics work; mostly reads, one UPDATE on
 * users based on aggregate order data. */
const complexA = [
  {
    /* A1: audit readings, no writes. Reads orders.status='canceled'
     * and orders.status='active' ranges, plus sums amounts. */
    sql: `
      WITH bystatus AS (
        SELECT status, SUM(amount) s FROM orders GROUP BY status
      )
      SELECT s FROM bystatus WHERE status='active'
    `,
  },
  {
    /* A2: promote users whose active orders exceed 150. CTE aggregate
     * over orders + UPDATE users. */
    sql: `
      WITH big AS (
        SELECT user_id, SUM(amount) s
        FROM orders WHERE status='active'
        GROUP BY user_id HAVING s > 150
      )
      UPDATE users SET tier='gold' WHERE id IN (SELECT user_id FROM big)
    `,
  },
  {
    /* A3: scan a single user's orders. */
    sql: "SELECT amount FROM orders WHERE user_id=1",
  },
];

/* Branch B -- concurrent bookkeeping updates that the ops team made
 * on a separate branch. */
const complexB = [
  {
    /* B1: insert a new big active order for user 3. Phantom against
     * A1 (active-range scan) and A2 (active-range CTE aggregate). */
    sql: "INSERT INTO orders VALUES(200, 3, 300.00, 'active')",
  },
  {
    /* B2: cancel two old orders via range predicate. Deletes touch
     * orders.status='canceled' range, and the WHERE touches user_id=2. */
    sql: "UPDATE orders SET status='canceled' WHERE user_id=2 AND amount<30",
  },
  {
    /* B3: rename user 1 -- should only collide with txs that touch
     * user 1 by id. */
    sql: "UPDATE users SET name='alice2' WHERE id=1",
  },
  {
    /* B4: remove a specific canceled order. Conflicts with A1/A2 via
     * the canceled-range scan (phantom), and potentially with the
     * purge-like txs. */
    sql: "DELETE FROM orders WHERE id=104",
  },
];

const complexResult = report(
  "COMPLEX: CTE aggregates, range scans, phantom inserts across branches",
  seedComplex, complexA, complexB
);
