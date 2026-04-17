/*
** track.c -- Implementation of read-tracking and query-logging.
**
** This module is compiled alongside the (patched) SQLite amalgamation.
** It has two linkage directions:
**
**   (1) The amalgamation calls into sqlite3Track* hooks declared in
**       track.h to report row-access events during VDBE execution.
**
**   (2) track.c calls back into sqlite3TrackTableNameByRootPage() --
**       a helper added to the amalgamation -- to resolve a cursor's
**       pgnoRoot into a human-readable table name.
*/
#include "track.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* Schema resolver implemented inside the patched sqlite3.c (see the
** "read-tracking support" hunk near end of file). */
extern const char *sqlite3TrackTableNameByRootPage(
  sqlite3 *db, int iDb, unsigned int pgnoRoot
);

/* Encode a VDBE register array (Mem[nMem]) as a JSON array string.
** Caller owns the returned buffer and must free it with free(). NULL on
** OOM. Implemented in the amalgamation (has access to Mem/MEM_* types). */
extern char *sqlite3TrackEncodeRowAsJson(void *aMem, int nMem);

/* ----- Internal datatypes --------------------------------------------- */

typedef struct TrackRead {
  const char *zTable;       /* pointer into name cache; not owned here */
  sqlite3_int64 rowid;
  int iQuery;               /* index into TrackState.aQuery */
  int isIndex;              /* 1 if the read came from an index cursor */
} TrackRead;

typedef struct TrackWrite {
  const char *zTable;
  sqlite3_int64 rowid;      /* -1 for whole-table TRUNCATE */
  int iQuery;
  char op;                  /* 'I' | 'U' | 'D' | 'T' */
} TrackWrite;

typedef struct TrackPred {
  const char *zTable;
  char *zKeyJson;           /* owned; NULL for kind=='r' */
  int iQuery;
  char kind;                /* 's' seek, 'e' end, 'r' rewind */
  char op;                  /* 'G','g','L','l','F' */
} TrackPred;

typedef struct TrackIdxWrite {
  const char *zTable;
  char *zKeyJson;           /* owned */
  sqlite3_int64 rowid;
  int iQuery;
  char op;                  /* 'I' | 'D' */
} TrackIdxWrite;

typedef struct TrackQuery {
  char *zSql;               /* owned copy of the SQL text */
  char *zRows;              /* JSON array; grown incrementally */
  int nRows;                /* chars used (excluding NUL) */
  int nRowsAlloc;           /* bytes allocated for zRows */
  int nEmitted;             /* number of result rows appended */
} TrackQuery;

typedef struct NameCacheEntry {
  int iDb;
  unsigned int pgnoRoot;
  char *zName;              /* owned */
} NameCacheEntry;

struct TrackState {
  sqlite3 *db;              /* the connection this is attached to */
  int enabled;

  /* Reads */
  TrackRead *aRead;
  int nRead;
  int nReadAlloc;

  /* Writes */
  TrackWrite *aWrite;
  int nWrite;
  int nWriteAlloc;

  /* Predicate events */
  TrackPred *aPred;
  int nPred;
  int nPredAlloc;

  /* Index writes */
  TrackIdxWrite *aIdxWrite;
  int nIdxWrite;
  int nIdxWriteAlloc;

  /* Queries */
  TrackQuery *aQuery;
  int nQuery;
  int nQueryAlloc;

  /* Name cache: (iDb, pgnoRoot) -> name */
  NameCacheEntry *aNameCache;
  int nNameCache;
  int nNameCacheAlloc;

  /* Per-statement dedup buffer: recently-seen (resolvedTableName,rowid)
  ** to avoid flooding the log when a single row is read many times. We
  ** key on the *resolved name* pointer (names are interned by the name
  ** cache, so two cursors on the same base table share the same pointer
  ** regardless of whether they came through an index or the table). */
  struct {
    const char *zTable;
    sqlite3_int64 rowid;
  } lastRead;
  int haveLastRead;

  /* Dump buffer (lazily built by sqlite3_track_dump_json) */
  char *zDump;
};

/* ----- Buffer helpers ------------------------------------------------- */

static int growBuf(char **pzBuf, int *pnAlloc, int want){
  if( want <= *pnAlloc ) return 0;
  int newAlloc = *pnAlloc ? *pnAlloc : 64;
  while( newAlloc < want ) newAlloc *= 2;
  char *p = (char*)realloc(*pzBuf, (size_t)newAlloc);
  if( !p ) return -1;
  *pzBuf = p;
  *pnAlloc = newAlloc;
  return 0;
}

static int appendStr(char **pzBuf, int *pn, int *pnAlloc, const char *z, int nz){
  if( nz < 0 ) nz = (int)strlen(z);
  if( growBuf(pzBuf, pnAlloc, *pn + nz + 1) ) return -1;
  memcpy(*pzBuf + *pn, z, (size_t)nz);
  *pn += nz;
  (*pzBuf)[*pn] = 0;
  return 0;
}

static int appendChar(char **pzBuf, int *pn, int *pnAlloc, char c){
  if( growBuf(pzBuf, pnAlloc, *pn + 2) ) return -1;
  (*pzBuf)[*pn] = c;
  (*pn)++;
  (*pzBuf)[*pn] = 0;
  return 0;
}

static int appendI64(char **pzBuf, int *pn, int *pnAlloc, sqlite3_int64 v){
  char tmp[32];
  int n = snprintf(tmp, sizeof(tmp), "%lld", (long long)v);
  return appendStr(pzBuf, pn, pnAlloc, tmp, n);
}

static int appendJsonString(char **pzBuf, int *pn, int *pnAlloc,
                            const char *z, int nz){
  if( nz < 0 ) nz = z ? (int)strlen(z) : 0;
  if( appendChar(pzBuf, pn, pnAlloc, '"') ) return -1;
  for(int i=0; i<nz; i++){
    unsigned char c = (unsigned char)z[i];
    if( c=='"' || c=='\\' ){
      if( appendChar(pzBuf, pn, pnAlloc, '\\') ) return -1;
      if( appendChar(pzBuf, pn, pnAlloc, (char)c) ) return -1;
    }else if( c=='\n' ){
      if( appendStr(pzBuf, pn, pnAlloc, "\\n", 2) ) return -1;
    }else if( c=='\r' ){
      if( appendStr(pzBuf, pn, pnAlloc, "\\r", 2) ) return -1;
    }else if( c=='\t' ){
      if( appendStr(pzBuf, pn, pnAlloc, "\\t", 2) ) return -1;
    }else if( c<0x20 ){
      char esc[8];
      int n = snprintf(esc, sizeof(esc), "\\u%04x", c);
      if( appendStr(pzBuf, pn, pnAlloc, esc, n) ) return -1;
    }else{
      if( appendChar(pzBuf, pn, pnAlloc, (char)c) ) return -1;
    }
  }
  if( appendChar(pzBuf, pn, pnAlloc, '"') ) return -1;
  return 0;
}

/* ----- Name cache ----------------------------------------------------- */

/* Cache the CANONICAL zName pointer from the schema (no copy). This is
** safe for the lifetime of the schema; if the caller drops/recreates a
** table mid-transaction they break the tracker's invariants, which is
** consistent with SQLite's own expectations for open cursors. Returning
** the canonical pointer lets us dedup by pointer identity: a lookup via
** an index cursor and via a table cursor both yield the SAME pointer. */
static const char *lookupName(TrackState *ts, int iDb, unsigned int pgno){
  for(int i=0; i<ts->nNameCache; i++){
    if( ts->aNameCache[i].iDb==iDb && ts->aNameCache[i].pgnoRoot==pgno ){
      return ts->aNameCache[i].zName;
    }
  }
  const char *z = sqlite3TrackTableNameByRootPage(ts->db, iDb, pgno);
  if( !z ) return NULL;
  if( ts->nNameCache==ts->nNameCacheAlloc ){
    int n = ts->nNameCacheAlloc ? ts->nNameCacheAlloc*2 : 8;
    NameCacheEntry *p = (NameCacheEntry*)realloc(
       ts->aNameCache, (size_t)n*sizeof(NameCacheEntry));
    if( !p ) return NULL;
    ts->aNameCache = p;
    ts->nNameCacheAlloc = n;
  }
  NameCacheEntry *e = &ts->aNameCache[ts->nNameCache++];
  e->iDb = iDb;
  e->pgnoRoot = pgno;
  e->zName = (char*)z;  /* non-owning pointer into schema */
  return e->zName;
}

/* ----- Attach / detach ------------------------------------------------ */

/* We store the tracker on db->pDbData via sqlite3_set_clientdata() so we
** avoid having to add a new field to struct sqlite3. The key is unique to
** this module, so it will not collide with caller usage. */
static const char *kClientDataKey = "sqlite3_track";

static void trackFreeQuery(TrackQuery *q){
  free(q->zSql);
  free(q->zRows);
}

static void trackFreeState(void *pArg){
  TrackState *ts = (TrackState*)pArg;
  if( !ts ) return;
  for(int i=0; i<ts->nQuery; i++) trackFreeQuery(&ts->aQuery[i]);
  free(ts->aQuery);
  free(ts->aRead);
  free(ts->aWrite);
  for(int i=0; i<ts->nPred; i++) free(ts->aPred[i].zKeyJson);
  free(ts->aPred);
  for(int i=0; i<ts->nIdxWrite; i++) free(ts->aIdxWrite[i].zKeyJson);
  free(ts->aIdxWrite);
  /* aNameCache[i].zName is a non-owning pointer into the SQLite schema;
  ** do NOT free. */
  free(ts->aNameCache);
  free(ts->zDump);
  free(ts);
}

TrackState *sqlite3TrackOfDb(sqlite3 *db){
  if( !db ) return NULL;
  return (TrackState*)sqlite3_get_clientdata(db, kClientDataKey);
}

static TrackState *ensureState(sqlite3 *db){
  TrackState *ts = sqlite3TrackOfDb(db);
  if( ts ) return ts;
  ts = (TrackState*)calloc(1, sizeof(*ts));
  if( !ts ) return NULL;
  ts->db = db;
  /* Register with free-on-close. */
  if( sqlite3_set_clientdata(db, kClientDataKey, ts, trackFreeState)!=SQLITE_OK ){
    free(ts);
    return NULL;
  }
  return ts;
}

void sqlite3TrackDetach(sqlite3 *db){
  /* Not strictly needed; sqlite3_close cleans up clientdata automatically. */
  sqlite3_set_clientdata(db, kClientDataKey, NULL, NULL);
}

/* ----- Resetting ------------------------------------------------------ */

static void resetCollected(TrackState *ts){
  for(int i=0; i<ts->nQuery; i++) trackFreeQuery(&ts->aQuery[i]);
  free(ts->aQuery); ts->aQuery=NULL; ts->nQuery=0; ts->nQueryAlloc=0;
  free(ts->aRead); ts->aRead=NULL; ts->nRead=0; ts->nReadAlloc=0;
  free(ts->aWrite); ts->aWrite=NULL; ts->nWrite=0; ts->nWriteAlloc=0;
  for(int i=0; i<ts->nPred; i++) free(ts->aPred[i].zKeyJson);
  free(ts->aPred); ts->aPred=NULL; ts->nPred=0; ts->nPredAlloc=0;
  for(int i=0; i<ts->nIdxWrite; i++) free(ts->aIdxWrite[i].zKeyJson);
  free(ts->aIdxWrite); ts->aIdxWrite=NULL; ts->nIdxWrite=0; ts->nIdxWriteAlloc=0;
  ts->haveLastRead = 0;
  free(ts->zDump); ts->zDump = NULL;
}

/* ----- Public API ----------------------------------------------------- */

int sqlite3_track_begin(sqlite3 *db){
  TrackState *ts = ensureState(db);
  if( !ts ) return SQLITE_NOMEM;
  resetCollected(ts);
  ts->enabled = 1;
  return SQLITE_OK;
}

int sqlite3_track_end(sqlite3 *db){
  TrackState *ts = sqlite3TrackOfDb(db);
  if( !ts ) return SQLITE_OK;
  ts->enabled = 0;
  return SQLITE_OK;
}

int sqlite3_track_reset(sqlite3 *db){
  TrackState *ts = sqlite3TrackOfDb(db);
  if( ts ) resetCollected(ts);
  return SQLITE_OK;
}

int sqlite3_track_is_enabled(sqlite3 *db){
  TrackState *ts = sqlite3TrackOfDb(db);
  return ts ? ts->enabled : 0;
}

int sqlite3_track_read_count(sqlite3 *db){
  TrackState *ts = sqlite3TrackOfDb(db);
  return ts ? ts->nRead : 0;
}

int sqlite3_track_read_get(
  sqlite3 *db, int i,
  const char **pzTable, sqlite3_int64 *pRowid, int *pQueryIndex
){
  TrackState *ts = sqlite3TrackOfDb(db);
  if( !ts || i<0 || i>=ts->nRead ) return 0;
  if( pzTable )    *pzTable = ts->aRead[i].zTable;
  if( pRowid )     *pRowid = ts->aRead[i].rowid;
  if( pQueryIndex) *pQueryIndex = ts->aRead[i].iQuery;
  return 1;
}

int sqlite3_track_write_count(sqlite3 *db){
  TrackState *ts = sqlite3TrackOfDb(db);
  return ts ? ts->nWrite : 0;
}

int sqlite3_track_write_get(
  sqlite3 *db, int i,
  const char **pzTable, sqlite3_int64 *pRowid, char *pOp, int *pQueryIndex
){
  TrackState *ts = sqlite3TrackOfDb(db);
  if( !ts || i<0 || i>=ts->nWrite ) return 0;
  if( pzTable )    *pzTable = ts->aWrite[i].zTable;
  if( pRowid )     *pRowid = ts->aWrite[i].rowid;
  if( pOp )        *pOp = ts->aWrite[i].op;
  if( pQueryIndex) *pQueryIndex = ts->aWrite[i].iQuery;
  return 1;
}

int sqlite3_track_predicate_count(sqlite3 *db){
  TrackState *ts = sqlite3TrackOfDb(db);
  return ts ? ts->nPred : 0;
}

int sqlite3_track_predicate_get(
  sqlite3 *db, int i,
  const char **pzTable, char *pKind, char *pOp,
  const char **pzKeyJson, int *pQueryIndex
){
  TrackState *ts = sqlite3TrackOfDb(db);
  if( !ts || i<0 || i>=ts->nPred ) return 0;
  if( pzTable )    *pzTable = ts->aPred[i].zTable;
  if( pKind )      *pKind = ts->aPred[i].kind;
  if( pOp )        *pOp = ts->aPred[i].op;
  if( pzKeyJson )  *pzKeyJson = ts->aPred[i].zKeyJson;
  if( pQueryIndex) *pQueryIndex = ts->aPred[i].iQuery;
  return 1;
}

int sqlite3_track_idxwrite_count(sqlite3 *db){
  TrackState *ts = sqlite3TrackOfDb(db);
  return ts ? ts->nIdxWrite : 0;
}

int sqlite3_track_idxwrite_get(
  sqlite3 *db, int i,
  const char **pzTable, const char **pzKeyJson,
  sqlite3_int64 *pRowid, char *pOp, int *pQueryIndex
){
  TrackState *ts = sqlite3TrackOfDb(db);
  if( !ts || i<0 || i>=ts->nIdxWrite ) return 0;
  if( pzTable )    *pzTable = ts->aIdxWrite[i].zTable;
  if( pzKeyJson )  *pzKeyJson = ts->aIdxWrite[i].zKeyJson;
  if( pRowid )     *pRowid = ts->aIdxWrite[i].rowid;
  if( pOp )        *pOp = ts->aIdxWrite[i].op;
  if( pQueryIndex) *pQueryIndex = ts->aIdxWrite[i].iQuery;
  return 1;
}

int sqlite3_track_query_count(sqlite3 *db){
  TrackState *ts = sqlite3TrackOfDb(db);
  return ts ? ts->nQuery : 0;
}

const char *sqlite3_track_query_sql(sqlite3 *db, int i){
  TrackState *ts = sqlite3TrackOfDb(db);
  if( !ts || i<0 || i>=ts->nQuery ) return NULL;
  return ts->aQuery[i].zSql;
}

const char *sqlite3_track_query_rows_json(sqlite3 *db, int i){
  TrackState *ts = sqlite3TrackOfDb(db);
  if( !ts || i<0 || i>=ts->nQuery ) return "[]";
  /* Every query's rows buffer is kept terminated; if empty, we never
  ** initialised it. Treat absence as "[]". */
  if( !ts->aQuery[i].zRows ) return "[]";
  return ts->aQuery[i].zRows;
}

const char *sqlite3_track_dump_json(sqlite3 *db){
  TrackState *ts = sqlite3TrackOfDb(db);
  if( !ts ) return "{\"reads\":[],\"writes\":[],\"queries\":[]}";
  free(ts->zDump); ts->zDump = NULL;
  int n=0, nAlloc=0;
  char *buf = NULL;
  if( appendStr(&buf,&n,&nAlloc, "{\"reads\":[", -1) ) goto oom;
  for(int i=0;i<ts->nRead;i++){
    if( i>0 && appendChar(&buf,&n,&nAlloc, ',') ) goto oom;
    if( appendStr(&buf,&n,&nAlloc, "{\"table\":", -1) ) goto oom;
    if( appendJsonString(&buf,&n,&nAlloc, ts->aRead[i].zTable, -1) ) goto oom;
    if( appendStr(&buf,&n,&nAlloc, ",\"rowid\":", -1) ) goto oom;
    if( appendI64(&buf,&n,&nAlloc, ts->aRead[i].rowid) ) goto oom;
    if( appendStr(&buf,&n,&nAlloc, ",\"query\":", -1) ) goto oom;
    if( appendI64(&buf,&n,&nAlloc, ts->aRead[i].iQuery) ) goto oom;
    if( appendStr(&buf,&n,&nAlloc, ",\"index\":", -1) ) goto oom;
    if( appendStr(&buf,&n,&nAlloc, ts->aRead[i].isIndex?"true":"false", -1) ) goto oom;
    if( appendChar(&buf,&n,&nAlloc, '}') ) goto oom;
  }
  if( appendStr(&buf,&n,&nAlloc, "],\"writes\":[", -1) ) goto oom;
  for(int i=0;i<ts->nWrite;i++){
    if( i>0 && appendChar(&buf,&n,&nAlloc, ',') ) goto oom;
    if( appendStr(&buf,&n,&nAlloc, "{\"table\":", -1) ) goto oom;
    if( appendJsonString(&buf,&n,&nAlloc, ts->aWrite[i].zTable, -1) ) goto oom;
    if( appendStr(&buf,&n,&nAlloc, ",\"rowid\":", -1) ) goto oom;
    if( appendI64(&buf,&n,&nAlloc, ts->aWrite[i].rowid) ) goto oom;
    if( appendStr(&buf,&n,&nAlloc, ",\"op\":\"", -1) ) goto oom;
    if( appendChar(&buf,&n,&nAlloc, ts->aWrite[i].op) ) goto oom;
    if( appendStr(&buf,&n,&nAlloc, "\",\"query\":", -1) ) goto oom;
    if( appendI64(&buf,&n,&nAlloc, ts->aWrite[i].iQuery) ) goto oom;
    if( appendChar(&buf,&n,&nAlloc, '}') ) goto oom;
  }
  if( appendStr(&buf,&n,&nAlloc, "],\"queries\":[", -1) ) goto oom;
  for(int i=0;i<ts->nQuery;i++){
    if( i>0 && appendChar(&buf,&n,&nAlloc, ',') ) goto oom;
    if( appendStr(&buf,&n,&nAlloc, "{\"sql\":", -1) ) goto oom;
    if( appendJsonString(&buf,&n,&nAlloc, ts->aQuery[i].zSql?ts->aQuery[i].zSql:"", -1) ) goto oom;
    if( appendStr(&buf,&n,&nAlloc, ",\"rows\":", -1) ) goto oom;
    if( appendStr(&buf,&n,&nAlloc,
        ts->aQuery[i].zRows ? ts->aQuery[i].zRows : "[]", -1) ) goto oom;
    if( appendChar(&buf,&n,&nAlloc, '}') ) goto oom;
  }
  if( appendStr(&buf,&n,&nAlloc, "]}", -1) ) goto oom;
  ts->zDump = buf;
  return buf;
oom:
  free(buf);
  return "{\"error\":\"oom\"}";
}

/* ----- VDBE hooks ----------------------------------------------------- */

int sqlite3TrackActive(TrackState *ts){
  return ts && ts->enabled;
}

int sqlite3TrackBeginQuery(TrackState *ts, const char *zSql){
  if( !sqlite3TrackActive(ts) ) return -1;
  if( !zSql ) zSql = "";
  if( ts->nQuery==ts->nQueryAlloc ){
    int n = ts->nQueryAlloc ? ts->nQueryAlloc*2 : 8;
    TrackQuery *p = (TrackQuery*)realloc(ts->aQuery, (size_t)n*sizeof(TrackQuery));
    if( !p ) return -1;
    ts->aQuery = p;
    ts->nQueryAlloc = n;
  }
  TrackQuery *q = &ts->aQuery[ts->nQuery];
  memset(q, 0, sizeof(*q));
  size_t n = strlen(zSql);
  q->zSql = (char*)malloc(n+1);
  if( !q->zSql ) return -1;
  memcpy(q->zSql, zSql, n+1);
  ts->haveLastRead = 0;
  return ts->nQuery++;
}

void sqlite3TrackResultRow(TrackState *ts, int iQuery, void *aMem, int nMem){
  if( !sqlite3TrackActive(ts) || iQuery<0 || iQuery>=ts->nQuery ) return;
  TrackQuery *q = &ts->aQuery[iQuery];
  char *row = sqlite3TrackEncodeRowAsJson(aMem, nMem);
  if( !row ) return;
  if( !q->zRows ){
    if( appendChar(&q->zRows, &q->nRows, &q->nRowsAlloc, '[') ){ free(row); return; }
  }else{
    /* Splice new row into the existing JSON array: strip trailing ']'. */
    if( q->nRows>0 && q->zRows[q->nRows-1]==']' ){
      q->nRows--;
      q->zRows[q->nRows] = 0;
      if( q->nEmitted>0 ){
        if( appendChar(&q->zRows, &q->nRows, &q->nRowsAlloc, ',') ){ free(row); return; }
      }
    }
  }
  if( appendStr(&q->zRows, &q->nRows, &q->nRowsAlloc, row, -1) ){ free(row); return; }
  if( appendChar(&q->zRows, &q->nRows, &q->nRowsAlloc, ']') ){ free(row); return; }
  q->nEmitted++;
  free(row);
}

void sqlite3TrackCursorRead(
  TrackState *ts,
  int iQuery,
  sqlite3 *db,
  int iDb,
  unsigned int pgnoRoot,
  sqlite3_int64 rowid,
  int isIndex
){
  if( !sqlite3TrackActive(ts) ) return;
  if( pgnoRoot==0 ) return;

  /* Resolve the base table name; interned by the name cache so pointer
  ** comparison works. */
  const char *zName = lookupName(ts, iDb, pgnoRoot);
  if( !zName ) return;

  /* Fast-path dedup: if the immediately preceding read was the same
  ** (table, rowid) pair, skip. This catches the dense OP_Column pattern
  ** where columns of a single row are extracted one after the other. */
  if( ts->haveLastRead
      && ts->lastRead.zTable==zName
      && ts->lastRead.rowid==rowid ){
    return;
  }

  /* Slow-path dedup: scan backwards through aRead[] within the current
  ** query, skipping if we've already logged this (table, rowid). This
  ** handles nested-loop patterns where the outer cursor is revisited
  ** after an inner scan advanced lastRead to a different table. The
  ** window is bounded (SQLITE_TRACK_DEDUP_WINDOW entries) so that very
  ** large linear scans stay O(1) amortised per read. Anything evicted
  ** beyond the window may reappear as a duplicate -- a deliberate
  ** tradeoff favouring throughput over perfect deduplication at scale. */
  #ifndef SQLITE_TRACK_DEDUP_WINDOW
  # define SQLITE_TRACK_DEDUP_WINDOW 256
  #endif
  int limit = SQLITE_TRACK_DEDUP_WINDOW;
  for(int i=ts->nRead-1; i>=0 && limit>0; i--, limit--){
    if( ts->aRead[i].iQuery != iQuery ) break;
    if( ts->aRead[i].zTable==zName && ts->aRead[i].rowid==rowid ){
      ts->lastRead.zTable = zName;
      ts->lastRead.rowid  = rowid;
      ts->haveLastRead    = 1;
      return;
    }
  }

  ts->lastRead.zTable = zName;
  ts->lastRead.rowid = rowid;
  ts->haveLastRead = 1;

  if( ts->nRead==ts->nReadAlloc ){
    int n = ts->nReadAlloc ? ts->nReadAlloc*2 : 16;
    TrackRead *p = (TrackRead*)realloc(ts->aRead, (size_t)n*sizeof(TrackRead));
    if( !p ) return;
    ts->aRead = p;
    ts->nReadAlloc = n;
  }
  TrackRead *r = &ts->aRead[ts->nRead++];
  r->zTable  = zName;
  r->rowid   = rowid;
  r->iQuery  = iQuery;
  r->isIndex = isIndex ? 1 : 0;
}

void sqlite3TrackPredicate(
  TrackState *ts,
  int iQuery,
  sqlite3 *db,
  int iDb,
  unsigned int pgnoRoot,
  char kind,
  char op,
  void *aMemKey,
  int nKey
){
  if( !sqlite3TrackActive(ts) ) return;
  if( pgnoRoot==0 ) return;
  const char *zName = lookupName(ts, iDb, pgnoRoot);
  if( !zName ) return;
  if( ts->nPred==ts->nPredAlloc ){
    int n = ts->nPredAlloc ? ts->nPredAlloc*2 : 8;
    TrackPred *p = (TrackPred*)realloc(ts->aPred, (size_t)n*sizeof(TrackPred));
    if( !p ) return;
    ts->aPred = p;
    ts->nPredAlloc = n;
  }
  char *zKey = NULL;
  if( kind!='r' && aMemKey && nKey>0 ){
    zKey = sqlite3TrackEncodeRowAsJson(aMemKey, nKey);
    if( !zKey ) return;
  }
  TrackPred *e = &ts->aPred[ts->nPred++];
  e->zTable   = zName;
  e->zKeyJson = zKey;
  e->iQuery   = iQuery;
  e->kind     = kind;
  e->op       = op;
}

void sqlite3TrackIndexWrite(
  TrackState *ts,
  int iQuery,
  sqlite3 *db,
  int iDb,
  unsigned int pgnoRoot,
  sqlite3_int64 rowid,
  void *aMemKey,
  int nKey,
  char op
){
  if( !sqlite3TrackActive(ts) ) return;
  if( pgnoRoot==0 ) return;
  const char *zName = lookupName(ts, iDb, pgnoRoot);
  if( !zName ) return;
  if( ts->nIdxWrite==ts->nIdxWriteAlloc ){
    int n = ts->nIdxWriteAlloc ? ts->nIdxWriteAlloc*2 : 8;
    TrackIdxWrite *p = (TrackIdxWrite*)realloc(
       ts->aIdxWrite, (size_t)n*sizeof(TrackIdxWrite));
    if( !p ) return;
    ts->aIdxWrite = p;
    ts->nIdxWriteAlloc = n;
  }
  char *zKey = NULL;
  if( aMemKey && nKey>0 ){
    zKey = sqlite3TrackEncodeRowAsJson(aMemKey, nKey);
    if( !zKey ) return;
  }
  TrackIdxWrite *e = &ts->aIdxWrite[ts->nIdxWrite++];
  e->zTable   = zName;
  e->zKeyJson = zKey;
  e->rowid    = rowid;
  e->iQuery   = iQuery;
  e->op       = op;
}

void sqlite3TrackCursorWrite(
  TrackState *ts,
  int iQuery,
  sqlite3 *db,
  int iDb,
  unsigned int pgnoRoot,
  sqlite3_int64 rowid,
  char op
){
  if( !sqlite3TrackActive(ts) ) return;
  if( pgnoRoot==0 ) return;
  const char *zName = lookupName(ts, iDb, pgnoRoot);
  if( !zName ) return;
  if( ts->nWrite==ts->nWriteAlloc ){
    int n = ts->nWriteAlloc ? ts->nWriteAlloc*2 : 16;
    TrackWrite *p = (TrackWrite*)realloc(ts->aWrite, (size_t)n*sizeof(TrackWrite));
    if( !p ) return;
    ts->aWrite = p;
    ts->nWriteAlloc = n;
  }
  TrackWrite *w = &ts->aWrite[ts->nWrite++];
  w->zTable = zName;
  w->rowid  = (op==SQLITE_TRACK_OP_TRUNCATE) ? -1 : rowid;
  w->iQuery = iQuery;
  w->op     = op;
}
