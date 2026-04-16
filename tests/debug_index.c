#include "sqlite3.h"
#include "track.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void){
  sqlite3 *db = 0;
  sqlite3_open(":memory:", &db);
  const char *seed =
    "CREATE TABLE posts(id INTEGER PRIMARY KEY, user_id INT, body TEXT);"
    "CREATE INDEX posts_user ON posts(user_id);"
    "INSERT INTO posts VALUES(10,1,'hi'),(11,1,'hello'),(12,2,'howdy'),(13,3,'hey');";
  sqlite3_exec(db, seed, 0, 0, 0);

  /* Print the VDBE program so we know what to expect. */
  sqlite3_stmt *s = 0;
  sqlite3_prepare_v2(db, "EXPLAIN SELECT body FROM posts WHERE user_id=1;", -1, &s, 0);
  while( sqlite3_step(s)==SQLITE_ROW ){
    printf("%3d %-15s %d %d %d %s\n",
       sqlite3_column_int(s,0),
       sqlite3_column_text(s,1) ? (const char*)sqlite3_column_text(s,1) : "",
       sqlite3_column_int(s,2),
       sqlite3_column_int(s,3),
       sqlite3_column_int(s,4),
       sqlite3_column_text(s,5) ? (const char*)sqlite3_column_text(s,5) : "");
  }
  sqlite3_finalize(s);

  puts("----");
  sqlite3_track_begin(db);
  sqlite3_exec(db, "SELECT body FROM posts WHERE user_id=1;", 0, 0, 0);
  sqlite3_track_end(db);

  int n = sqlite3_track_read_count(db);
  printf("reads = %d\n", n);
  for(int i=0;i<n;i++){
    const char *t=0; sqlite3_int64 r=0; int q=0;
    sqlite3_track_read_get(db, i, &t, &r, &q);
    printf("  %d: table=%s rowid=%lld query=%d\n", i, t, (long long)r, q);
  }
  sqlite3_close(db);
  return 0;
}
