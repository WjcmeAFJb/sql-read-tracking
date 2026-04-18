import initSqliteTracked from "sqlite3-read-tracking";

const SQL = await initSqliteTracked();

/* One DB per run so each "run" button click starts from the same
 * snapshot. That is the model a rw-conflict checker would use. */
function freshDb() {
  const db = new SQL.Database();
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, age INT);
    INSERT INTO users VALUES
      (1,'alice',30),(2,'bob',40),(3,'carol',25);
  `);
  return db;
}

const $ = (id) => document.getElementById(id);

function render(db) {
  $("reads").textContent   = JSON.stringify(db.getReadLog(),   null, 2);
  $("writes").textContent  = JSON.stringify(db.getWriteLog(),  null, 2);
  $("queries").textContent = JSON.stringify(db.getQueryLog(),  null, 2);
}

$("run").addEventListener("click", () => {
  const db = freshDb();
  db.beginTracking();
  try {
    db.exec($("sql").value);
  } catch (e) {
    $("queries").textContent = "ERROR: " + e.message;
  }
  db.endTracking();
  render(db);
  db.close();
});
