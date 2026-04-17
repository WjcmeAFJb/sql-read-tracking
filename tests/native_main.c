/*
** native_main.c -- Minimal C test runner for the read-tracking layer.
**
** Links directly against the patched amalgamation (sqlite3.o) plus
** track.o. The JS/WASM tests in tests/sqljs.test.mjs exercise the
** same scenarios over the emscripten-built artifact.
**
** Tests are registered via RUN(name, fn); failures abort with a
** non-zero exit status and print context. This keeps dependencies
** to zero -- we only use libc + sqlite3 + track.
*/
#include "sqlite3.h"
#include "track.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>

static int g_pass = 0, g_fail = 0;
static const char *g_current = "";

#define FAIL(fmt, ...) do {                                          \
  fprintf(stderr, "  FAIL [%s]: " fmt "\n", g_current, ##__VA_ARGS__);\
  g_fail++;                                                           \
  return;                                                             \
} while(0)

#define OK(cond, msg) do { if(!(cond)){ FAIL("%s", msg); } } while(0)
#define EQ_I(a, b, msg) do { \
  long long _a=(long long)(a), _b=(long long)(b); \
  if(_a!=_b){ FAIL("%s: got %lld want %lld", msg, _a, _b); } \
} while(0)
#define EQ_S(a, b, msg) do { \
  const char *_a=(a), *_b=(b); \
  if( strcmp(_a?_a:"<null>", _b?_b:"<null>")!=0 ){ \
    FAIL("%s: got \"%s\" want \"%s\"", msg, _a?_a:"<null>", _b?_b:"<null>"); \
  } \
} while(0)

/* --- helpers --------------------------------------------------------- */

static sqlite3 *open_seeded(void){
  sqlite3 *db = 0;
  if( sqlite3_open(":memory:", &db) ) abort();
  const char *seed =
    "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, age INT);"
    "CREATE TABLE posts(id INTEGER PRIMARY KEY, user_id INT, body TEXT);"
    "CREATE INDEX posts_user ON posts(user_id);"
    "INSERT INTO users VALUES(1,'alice',30),(2,'bob',40),(3,'carol',25);"
    "INSERT INTO posts VALUES(10,1,'hi'),(11,1,'hello'),(12,2,'howdy'),(13,3,'hey');";
  char *err = 0;
  if( sqlite3_exec(db, seed, 0, 0, &err) ){
    fprintf(stderr, "seed failed: %s\n", err);
    abort();
  }
  return db;
}

static void exec_ok(sqlite3 *db, const char *sql){
  char *err = 0;
  int rc = sqlite3_exec(db, sql, 0, 0, &err);
  if( rc ){
    fprintf(stderr, "exec failed: %s (%s)\n", sql, err?err:"?");
    abort();
  }
}

static int has_read(sqlite3 *db, const char *tbl, sqlite3_int64 rid){
  int n = sqlite3_track_read_count(db);
  for(int i=0;i<n;i++){
    const char *t = 0, *c = 0;
    int iCol = 0, q = 0;
    sqlite3_int64 r = 0;
    sqlite3_track_read_get(db, i, &t, &c, &iCol, &r, &q);
    if( t && strcmp(t,tbl)==0 && r==rid ) return 1;
  }
  return 0;
}

static int has_column_read(
  sqlite3 *db, const char *tbl, sqlite3_int64 rid, const char *col
){
  int n = sqlite3_track_read_count(db);
  for(int i=0;i<n;i++){
    const char *t = 0, *c = 0;
    int iCol = 0, q = 0;
    sqlite3_int64 r = 0;
    sqlite3_track_read_get(db, i, &t, &c, &iCol, &r, &q);
    if( t && c && strcmp(t,tbl)==0 && r==rid && strcmp(c,col)==0 ) return 1;
  }
  return 0;
}

static int has_write(sqlite3 *db, const char *tbl, sqlite3_int64 rid, char op){
  int n = sqlite3_track_write_count(db);
  for(int i=0;i<n;i++){
    const char *t = 0; sqlite3_int64 r=0; char o=0; int q=0;
    sqlite3_track_write_get(db, i, &t, &r, &o, &q);
    if( t && strcmp(t,tbl)==0 && r==rid && o==op ) return 1;
  }
  return 0;
}

static int count_writes(sqlite3 *db, const char *tbl){
  int n = sqlite3_track_write_count(db), c=0;
  for(int i=0;i<n;i++){
    const char *t = 0; sqlite3_int64 r=0; char o=0; int q=0;
    sqlite3_track_write_get(db, i, &t, &r, &o, &q);
    if( t && strcmp(t,tbl)==0 ) c++;
  }
  return c;
}

/* Count reads attributed to a particular (table, query) pair. */
static int count_reads(sqlite3 *db, const char *tbl, int iQ){
  int n = sqlite3_track_read_count(db);
  int c = 0;
  for(int i=0;i<n;i++){
    const char *t = 0, *col = 0;
    int iCol = 0, q = 0;
    sqlite3_int64 r = 0;
    sqlite3_track_read_get(db, i, &t, &col, &iCol, &r, &q);
    if( t && strcmp(t,tbl)==0 && q==iQ ) c++;
  }
  return c;
}

/* Count distinct rowids read for a table. Collapses per-column duplicates. */
static int count_rows(sqlite3 *db, const char *tbl){
  int n = sqlite3_track_read_count(db);
  sqlite3_int64 seen[128]; int nSeen = 0;
  for(int i=0;i<n;i++){
    const char *t = 0, *col = 0;
    int iCol = 0, q = 0;
    sqlite3_int64 r = 0;
    sqlite3_track_read_get(db, i, &t, &col, &iCol, &r, &q);
    if( !t || strcmp(t,tbl)!=0 ) continue;
    int dup = 0;
    for(int j=0;j<nSeen;j++) if( seen[j]==r ){ dup=1; break; }
    if( !dup && nSeen<128 ) seen[nSeen++] = r;
  }
  return nSeen;
}

/* --- tests ----------------------------------------------------------- */

static void test_basic_select(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "SELECT * FROM users WHERE id=2;");
  sqlite3_track_end(db);

  OK(has_read(db, "users", 2), "read of users.2 not recorded");
  OK(!has_read(db, "users", 1), "read of users.1 unexpectedly recorded");
  EQ_I(sqlite3_track_query_count(db), 1, "query count");
  EQ_S(sqlite3_track_query_sql(db, 0),
       "SELECT * FROM users WHERE id=2;", "query sql");
  EQ_S(sqlite3_track_query_rows_json(db, 0),
       "[[2,\"bob\",40]]", "query rows");
  g_pass++;
  sqlite3_close(db);
}

static void test_full_table_scan(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "SELECT name FROM users;");
  sqlite3_track_end(db);

  OK(has_read(db, "users", 1), "users.1 not tracked");
  OK(has_read(db, "users", 2), "users.2 not tracked");
  OK(has_read(db, "users", 3), "users.3 not tracked");
  EQ_I(sqlite3_track_read_count(db), 3, "only users should be read");
  g_pass++;
  sqlite3_close(db);
}

static void test_cte(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db,
    "WITH adults AS (SELECT id FROM users WHERE age>=30) "
    "SELECT u.name FROM users u JOIN adults a ON a.id=u.id;"
  );
  sqlite3_track_end(db);

  OK(has_read(db, "users", 1), "alice");
  OK(has_read(db, "users", 2), "bob");
  /* carol (age 25) should NOT appear as an adult match, but the scan
  ** still reads her row during the initial filter. */
  OK(has_read(db, "users", 3), "carol should be scanned once");
  g_pass++;
  sqlite3_close(db);
}

static void test_join_with_index(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db,
    "SELECT u.name, p.body FROM users u "
    "JOIN posts p ON p.user_id = u.id WHERE u.id IN (1,2);"
  );
  sqlite3_track_end(db);

  OK(has_read(db, "users", 1), "users.1");
  OK(has_read(db, "users", 2), "users.2");
  OK(has_read(db, "posts", 10), "posts.10");
  OK(has_read(db, "posts", 11), "posts.11");
  OK(has_read(db, "posts", 12), "posts.12");
  OK(!has_read(db, "posts", 13), "posts.13 should NOT be read");
  g_pass++;
  sqlite3_close(db);
}

static void test_update_subquery(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db,
    "UPDATE users SET age = age + 1 "
    "WHERE id IN (SELECT user_id FROM posts WHERE body='hello');"
  );
  sqlite3_track_end(db);

  /* The subquery scans posts; the outer UPDATE reads users.1 (alice). */
  OK(has_read(db, "posts", 11), "posts.11 (matches 'hello')");
  OK(has_read(db, "users", 1), "users.1 (target of UPDATE)");
  /* The UPDATE mutates users.1 but the tracker distinguishes reads
  ** from writes via the read log -- any row we touched counts. */
  EQ_I(sqlite3_track_query_count(db), 1, "one outer statement");
  g_pass++;
  sqlite3_close(db);
}

static void test_delete_conditional(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "DELETE FROM posts WHERE user_id=3;");
  sqlite3_track_end(db);

  OK(has_read(db, "posts", 13), "posts.13 read before delete");
  OK(!has_read(db, "posts", 10), "posts.10 NOT touched");
  g_pass++;
  sqlite3_close(db);
}

static void test_insert_select(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db,
    "CREATE TABLE audit(id INTEGER PRIMARY KEY, who TEXT);"
    "INSERT INTO audit(who) SELECT name FROM users WHERE age>30;"
  );
  sqlite3_track_end(db);

  OK(has_read(db, "users", 1), "alice scanned");
  OK(has_read(db, "users", 2), "bob scanned");
  OK(has_read(db, "users", 3), "carol scanned");
  g_pass++;
  sqlite3_close(db);
}

static void test_transaction_scope(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "BEGIN;");
  exec_ok(db, "SELECT * FROM users WHERE id=1;");
  exec_ok(db, "SELECT * FROM posts WHERE id=12;");
  exec_ok(db, "COMMIT;");
  sqlite3_track_end(db);

  EQ_I(sqlite3_track_query_count(db), 4, "4 stmts: begin, 2 selects, commit");
  OK(has_read(db, "users", 1), "users.1");
  OK(has_read(db, "posts", 12), "posts.12");
  g_pass++;
  sqlite3_close(db);
}

static void test_reset_between_runs(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "SELECT * FROM users WHERE id=1;");
  /* SELECT * on a 3-column table with PK lookup logs the rowid probe
  ** plus OP_Column for each fetched column; we just care that 1 *row*
  ** was read. */
  EQ_I(count_rows(db, "users"), 1, "exactly one row after first run");

  sqlite3_track_begin(db); /* re-begin resets */
  EQ_I(sqlite3_track_read_count(db), 0, "after re-begin");
  exec_ok(db, "SELECT * FROM users WHERE id=2;");
  OK(has_read(db, "users", 2), "second run still tracks");
  OK(!has_read(db, "users", 1), "first run's read cleared");
  g_pass++;
  sqlite3_close(db);
}

static void test_disabled_no_tracking(void){
  sqlite3 *db = open_seeded();
  /* never call track_begin */
  exec_ok(db, "SELECT * FROM users;");
  EQ_I(sqlite3_track_read_count(db), 0, "no reads tracked when disabled");
  EQ_I(sqlite3_track_query_count(db), 0, "no queries logged when disabled");
  g_pass++;
  sqlite3_close(db);
}

static void test_dump_json_shape(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "SELECT id FROM users WHERE id=2;");
  sqlite3_track_end(db);

  const char *dump = sqlite3_track_dump_json(db);
  OK(dump != 0, "dump not null");
  OK(strstr(dump, "\"table\":\"users\"") != 0, "dump has users");
  OK(strstr(dump, "\"rowid\":2") != 0, "dump has rowid 2");
  OK(strstr(dump, "SELECT id FROM users WHERE id=2") != 0, "dump has sql");
  g_pass++;
  sqlite3_close(db);
}

static void test_string_and_null_values(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db,
    "CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT, x);"
    "INSERT INTO t VALUES(1,'hi\\n\"world', NULL);"
    "SELECT * FROM t;"
  );
  sqlite3_track_end(db);
  int n = sqlite3_track_query_count(db);
  OK(n >= 1, "at least one query");
  const char *rows = sqlite3_track_query_rows_json(db, n-1);
  OK(strstr(rows, "null") != 0, "null encoded");
  /* The SQL literal here is a *C* escape that writes a literal backslash-n
  ** and a quote into the row; the JSON encoder must re-escape those. */
  OK(strstr(rows, "\\\\n") != 0 || strstr(rows, "\\n") != 0,
     "string escapes present");
  g_pass++;
  sqlite3_close(db);
}

static void test_index_lookup_attribution(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  /* posts_user is a secondary index; a lookup against it should still
  ** surface the reads as coming from the base "posts" table. */
  exec_ok(db, "SELECT body FROM posts WHERE user_id=1;");
  sqlite3_track_end(db);

  OK(has_read(db, "posts", 10), "posts.10 via index");
  OK(has_read(db, "posts", 11), "posts.11 via index");
  /* The base-table resolution means callers see "posts", not
  ** "posts_user" (the index name). With column granularity we expect
  ** one "rowid" event (from OP_DeferredSeek via the index) and one
  ** "body" event (from OP_Column on the table cursor) per matching
  ** row -- four entries for two rows. Two *rows* are read. */
  EQ_I(count_rows(db, "posts"), 2, "two distinct posts rows read");
  g_pass++;
  sqlite3_close(db);
}

static void test_column_level_reads(void){
  /* SELECT of one column should log a read with column=name (not
  ** "rowid") for each row scanned. */
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "SELECT name FROM users;");
  sqlite3_track_end(db);

  OK(has_column_read(db, "users", 1, "name"), "users.1.name");
  OK(has_column_read(db, "users", 2, "name"), "users.2.name");
  OK(has_column_read(db, "users", 3, "name"), "users.3.name");
  OK(!has_column_read(db, "users", 1, "age"),
     "age not read (not in SELECT list)");
  g_pass++;
  sqlite3_close(db);
}

/* --- write-tracking tests ------------------------------------------- */

static void test_insert_tracked(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "INSERT INTO users VALUES(4,'dave',50);");
  sqlite3_track_end(db);

  OK(has_write(db, "users", 4, 'I'), "insert of users.4 not tracked");
  EQ_I(sqlite3_track_write_count(db), 1, "one write expected");
  g_pass++;
  sqlite3_close(db);
}

static void test_delete_tracked(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "DELETE FROM users WHERE id=2;");
  sqlite3_track_end(db);

  OK(has_write(db, "users", 2, 'D'), "delete of users.2 not tracked");
  g_pass++;
  sqlite3_close(db);
}

static void test_update_emits_update_op(void){
  /* SQLite's planner lowers simple UPDATE on a rowid table to a single
  ** OP_Insert with OPFLAG_ISUPDATE (insert-over-existing-rowid). We
  ** surface that as 'U' so downstream code can distinguish it from a
  ** true INSERT without losing the row identity. */
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "UPDATE users SET age=99 WHERE id=1;");
  sqlite3_track_end(db);

  OK(has_write(db, "users", 1, 'U'), "UPDATE logged as 'U'");
  OK(!has_write(db, "users", 1, 'I'), "NOT tagged as plain insert");
  EQ_I(count_writes(db, "users"), 1, "exactly one write event");
  g_pass++;
  sqlite3_close(db);
}

static void test_truncate_optimization(void){
  /* Unconstrained DELETE triggers SQLite's truncate optimization:
  ** no per-row OP_Delete fires; sqlite3_update_hook would miss it.
  ** Our VDBE-level instrumentation records a wildcard TRUNCATE event. */
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "DELETE FROM posts;");
  sqlite3_track_end(db);

  OK(has_write(db, "posts", -1, 'T'), "truncate wildcard not recorded");
  /* Per-row deletes are NOT emitted on this path -- that's the point. */
  OK(!has_write(db, "posts", 10, 'D'), "should NOT see per-row delete");
  g_pass++;
  sqlite3_close(db);
}

static void test_delete_with_where_not_truncated(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "DELETE FROM posts WHERE user_id=1;");
  sqlite3_track_end(db);

  /* With a WHERE the planner uses per-row OP_Delete. */
  OK(has_write(db, "posts", 10, 'D'), "posts.10 deleted");
  OK(has_write(db, "posts", 11, 'D'), "posts.11 deleted");
  OK(!has_write(db, "posts", -1, 'T'), "no truncate event");
  g_pass++;
  sqlite3_close(db);
}

static void test_insert_or_replace_conflict(void){
  /* ON CONFLICT REPLACE deletes the conflicting row inline without
  ** firing sqlite3_update_hook. Our VDBE hook catches it because it
  ** still goes through OP_Delete. */
  sqlite3 *db = open_seeded();
  exec_ok(db, "CREATE UNIQUE INDEX users_name ON users(name);");
  sqlite3_track_begin(db);
  /* 'alice' already exists at rowid=1; REPLACE should delete rowid=1
  ** and insert the new row. */
  exec_ok(db, "INSERT OR REPLACE INTO users(id,name,age) VALUES(99,'alice',77);");
  sqlite3_track_end(db);

  OK(has_write(db, "users", 1, 'D'), "conflict deletion of rowid=1");
  OK(has_write(db, "users", 99, 'I'), "insertion of rowid=99");
  g_pass++;
  sqlite3_close(db);
}

static void test_write_log_query_attribution(void){
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "INSERT INTO users VALUES(5,'eve',18);");
  exec_ok(db, "DELETE FROM users WHERE id=3;");
  sqlite3_track_end(db);

  int n = sqlite3_track_write_count(db);
  EQ_I(n, 2, "two writes");
  const char *t=0; sqlite3_int64 r=0; char o=0; int q=0;
  sqlite3_track_write_get(db, 0, &t, &r, &o, &q);
  EQ_I(q, 0, "first write belongs to first stmt");
  sqlite3_track_write_get(db, 1, &t, &r, &o, &q);
  EQ_I(q, 1, "second write belongs to second stmt");
  g_pass++;
  sqlite3_close(db);
}

static void test_rollback_keeps_write_log(void){
  /* Rollback undoes data but the tracker is a *history* of what the VDBE
  ** attempted; rollback does not retract prior log entries. Serializable
  ** conflict detection runs against the intended writes, not the
  ** durably-committed ones. */
  sqlite3 *db = open_seeded();
  sqlite3_track_begin(db);
  exec_ok(db, "BEGIN;");
  exec_ok(db, "INSERT INTO users VALUES(10,'zed',99);");
  exec_ok(db, "ROLLBACK;");
  sqlite3_track_end(db);

  OK(has_write(db, "users", 10, 'I'), "insert logged even after rollback");
  g_pass++;
  sqlite3_close(db);
}

static void test_rw_graph_happy_path(void){
  /* End-to-end shape check: T1's read set and T2's write set are
  ** inspected together, an overlap means an rw-edge. */
  sqlite3 *db = open_seeded();

  /* Simulated T1: read users.2 */
  sqlite3_track_begin(db);
  exec_ok(db, "SELECT name FROM users WHERE id=2;");
  sqlite3_track_end(db);
  OK(count_rows(db, "users") == 1, "T1 read exactly one row");
  /* Snapshot T1 state -- take the first read's (table, rowid). */
  sqlite3_int64 t1_rowid = 0; const char *t1_tbl = 0, *t1_col = 0;
  int t1_icol = 0, t1_q = 0;
  sqlite3_track_read_get(db, 0, &t1_tbl, &t1_col, &t1_icol,
                         &t1_rowid, &t1_q);

  /* Simulated T2: write users.2 (emulates DELETE by a concurrent txn) */
  sqlite3_track_begin(db); /* resets */
  exec_ok(db, "UPDATE users SET age=41 WHERE id=2;");
  sqlite3_track_end(db);

  /* Conflict check: any of T2's writes against T1's reads? */
  int overlap = 0;
  int nw = sqlite3_track_write_count(db);
  for(int i=0;i<nw;i++){
    const char *tbl=0; sqlite3_int64 rid=0; char op=0; int q=0;
    sqlite3_track_write_get(db, i, &tbl, &rid, &op, &q);
    if( tbl && strcmp(tbl,t1_tbl)==0
        && (rid==t1_rowid || op=='T') ){
      overlap = 1;
      break;
    }
  }
  OK(overlap, "rw-dependency detected between T1 read and T2 write");
  g_pass++;
  sqlite3_close(db);
}

/* --- main ------------------------------------------------------------ */

#define RUN(fn) do { g_current = #fn; printf("[.] %s\n", #fn); fn(); } while(0)

int main(void){
  RUN(test_basic_select);
  RUN(test_full_table_scan);
  RUN(test_cte);
  RUN(test_join_with_index);
  RUN(test_update_subquery);
  RUN(test_delete_conditional);
  RUN(test_insert_select);
  RUN(test_transaction_scope);
  RUN(test_reset_between_runs);
  RUN(test_disabled_no_tracking);
  RUN(test_dump_json_shape);
  RUN(test_string_and_null_values);
  RUN(test_index_lookup_attribution);
  RUN(test_column_level_reads);

  RUN(test_insert_tracked);
  RUN(test_delete_tracked);
  RUN(test_update_emits_update_op);
  RUN(test_truncate_optimization);
  RUN(test_delete_with_where_not_truncated);
  RUN(test_insert_or_replace_conflict);
  RUN(test_write_log_query_attribution);
  RUN(test_rollback_keeps_write_log);
  RUN(test_rw_graph_happy_path);

  printf("\n%d passed, %d failed\n", g_pass, g_fail);
  return g_fail ? 1 : 0;
}
