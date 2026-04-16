/*
** track.h -- Read-tracking and query-logging extension to SQLite.
**
** This header declares both the low-level hooks used by the patched
** sqlite3.c amalgamation and the public API exposed to callers (C, WASM).
**
** Public API entry points are prefixed "sqlite3_track_"; internal
** VDBE-facing helpers are prefixed "sqlite3Track".
*/
#ifndef SQLITE_TRACK_H
#define SQLITE_TRACK_H

#include "sqlite3.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ----- Public API (for application / WASM bindings) -------------------- */

/* Turn tracking on for this connection. Resets any previously collected
** reads/queries. Returns SQLITE_OK or an error code. */
int sqlite3_track_begin(sqlite3 *db);

/* Turn tracking off. Collected data remains available until the next
** sqlite3_track_begin() or sqlite3_track_reset(). */
int sqlite3_track_end(sqlite3 *db);

/* Discard all collected reads and queries. */
int sqlite3_track_reset(sqlite3 *db);

/* Number of (table, rowid) reads logged so far. */
int sqlite3_track_read_count(sqlite3 *db);

/* Retrieve the i-th read. Returns 1 on success, 0 if i is out of range.
** The returned string is owned by the tracker; do not free. */
int sqlite3_track_read_get(
  sqlite3 *db, int i,
  const char **pzTable,
  sqlite3_int64 *pRowid,
  int *pQueryIndex
);

/* Number of logged queries. */
int sqlite3_track_query_count(sqlite3 *db);

/* i-th logged query's SQL text. Returned string owned by tracker. */
const char *sqlite3_track_query_sql(sqlite3 *db, int i);

/* i-th logged query's result rows as a JSON array of arrays
** (e.g. [[1,"foo"],[2,"bar"]]). Always returns valid JSON; empty
** SELECT results and mutative queries return "[]". */
const char *sqlite3_track_query_rows_json(sqlite3 *db, int i);

/* Whether tracking is currently enabled. */
int sqlite3_track_is_enabled(sqlite3 *db);

/* Serialize the entire tracker state as one JSON document of shape:
** {"reads":[{"table":"t","rowid":1,"query":0}, ...],
**  "queries":[{"sql":"...","rows":[[...]]}, ...]}
** Returned buffer is owned by tracker; do not free. */
const char *sqlite3_track_dump_json(sqlite3 *db);

/* ----- Internal hooks used by patched sqlite3.c ------------------------ */

typedef struct TrackState TrackState;

/* Retrieve tracker attached to db (or NULL if never attached).
** Declared inline-ish for call-site inlining: looks at db->pTracker. */
TrackState *sqlite3TrackOfDb(sqlite3 *db);

/* Called in sqlite3_close path. */
void sqlite3TrackDetach(sqlite3 *db);

/* Convenience: returns 1 iff tracker attached AND enabled. */
int sqlite3TrackActive(TrackState *ts);

/* Called from Vdbe step transition to VDBE_RUN_STATE.
** Returns the query index assigned to this statement (>=0), or -1 if
** tracking is not active. Safe to call with ts==NULL. */
int sqlite3TrackBeginQuery(TrackState *ts, const char *zSql);

/* Called from OP_ResultRow. aMem points to p->nResColumn Mem values. */
void sqlite3TrackResultRow(TrackState *ts, int iQuery, void *aMem, int nMem);

/* Called from row-access opcodes (OP_Rowid, OP_Column, OP_IdxRowid,
** OP_SeekRowid, OP_NotExists, OP_Found/OP_NotFound for indexes, etc.).
** db is used to resolve pgnoRoot -> table name (cached). */
void sqlite3TrackCursorRead(
  TrackState *ts,
  int iQuery,
  sqlite3 *db,
  int iDb,
  unsigned int pgnoRoot,
  sqlite3_int64 rowid,
  int isIndex
);

#ifdef __cplusplus
}
#endif
#endif /* SQLITE_TRACK_H */
