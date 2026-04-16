/* global
    Module
    HEAP8
    HEAPU8
    HEAP32
    _malloc
    _free
    cwrap
    ccall
    UTF8ToString
    stringToUTF8
    lengthBytesUTF8
    getValue
    setValue
    stackAlloc
    stackSave
    stackRestore
*/
/*
** api.js -- Public JS/WASM surface for the read-tracking SQLite build.
**
** Modeled after sql.js's Database/Statement classes so code using
** sql.js can migrate with minimal friction. Adds a tracking API:
**
**   db.beginTracking()
**   db.endTracking()
**   db.resetTracking()
**   db.isTracking()                -> boolean
**   db.getReadLog()                -> [{table, rowid, query, isIndex}]
**   db.getQueryLog()               -> [{sql, rows}]
**   db.dumpTracking()              -> full JSON string
**
** The tracking state is per-connection and is preserved across
** statement boundaries until the next beginTracking() or
** resetTracking() call. This lets callers record all reads that
** happened inside a multi-statement transaction.
*/
"use strict";

Module["onRuntimeInitialized"] = function onRuntimeInitialized(){
  var NULL = 0;
  var SQLITE_OK = 0;
  var SQLITE_ROW = 100;
  var SQLITE_DONE = 101;
  var SQLITE_INTEGER = 1;
  var SQLITE_FLOAT = 2;
  var SQLITE_TEXT = 3;
  var SQLITE_BLOB = 4;
  var SQLITE_NULL = 5;

  /* ----- cwrap bindings --------------------------------------------- */

  var sqlite3_open = cwrap("sqlite3_open", "number",
                           ["string", "number"]);
  var sqlite3_close_v2 = cwrap("sqlite3_close_v2", "number", ["number"]);
  var sqlite3_errmsg = cwrap("sqlite3_errmsg", "string", ["number"]);
  var sqlite3_changes = cwrap("sqlite3_changes", "number", ["number"]);
  var sqlite3_prepare_v2 = cwrap("sqlite3_prepare_v2", "number",
    ["number", "string", "number", "number", "number"]);
  var sqlite3_step = cwrap("sqlite3_step", "number", ["number"]);
  var sqlite3_reset = cwrap("sqlite3_reset", "number", ["number"]);
  var sqlite3_finalize = cwrap("sqlite3_finalize", "number", ["number"]);
  var sqlite3_clear_bindings = cwrap("sqlite3_clear_bindings", "number",
                                     ["number"]);
  var sqlite3_sql = cwrap("sqlite3_sql", "string", ["number"]);

  var sqlite3_column_count = cwrap("sqlite3_column_count", "number",
                                   ["number"]);
  var sqlite3_column_name = cwrap("sqlite3_column_name", "string",
                                  ["number", "number"]);
  var sqlite3_column_type = cwrap("sqlite3_column_type", "number",
                                  ["number", "number"]);
  var sqlite3_column_double = cwrap("sqlite3_column_double", "number",
                                    ["number", "number"]);
  var sqlite3_column_text = cwrap("sqlite3_column_text", "string",
                                  ["number", "number"]);
  var sqlite3_column_int = cwrap("sqlite3_column_int", "number",
                                 ["number", "number"]);
  var sqlite3_column_bytes = cwrap("sqlite3_column_bytes", "number",
                                   ["number", "number"]);
  var sqlite3_column_blob_ptr = cwrap("sqlite3_column_blob", "number",
                                      ["number", "number"]);

  var sqlite3_bind_text = cwrap("sqlite3_bind_text", "number",
    ["number", "number", "string", "number", "number"]);
  var sqlite3_bind_int = cwrap("sqlite3_bind_int", "number",
    ["number", "number", "number"]);
  var sqlite3_bind_double = cwrap("sqlite3_bind_double", "number",
    ["number", "number", "number"]);
  var sqlite3_bind_null = cwrap("sqlite3_bind_null", "number",
    ["number", "number"]);
  var sqlite3_bind_blob = cwrap("sqlite3_bind_blob", "number",
    ["number", "number", "number", "number", "number"]);
  var sqlite3_bind_parameter_index = cwrap("sqlite3_bind_parameter_index",
    "number", ["number", "string"]);
  var sqlite3_bind_parameter_count = cwrap("sqlite3_bind_parameter_count",
    "number", ["number"]);

  /* Tracking bindings */
  var _track_begin        = cwrap("sqlite3_track_begin", "number", ["number"]);
  var _track_end          = cwrap("sqlite3_track_end", "number", ["number"]);
  var _track_reset        = cwrap("sqlite3_track_reset", "number", ["number"]);
  var _track_is_enabled   = cwrap("sqlite3_track_is_enabled", "number",
                                  ["number"]);
  var _track_read_count   = cwrap("sqlite3_track_read_count", "number",
                                  ["number"]);
  var _track_read_get     = cwrap("sqlite3_track_read_get", "number",
    ["number", "number", "number", "number", "number"]);
  var _track_query_count  = cwrap("sqlite3_track_query_count", "number",
                                  ["number"]);
  var _track_query_sql    = cwrap("sqlite3_track_query_sql", "string",
                                  ["number", "number"]);
  var _track_query_rows_json = cwrap("sqlite3_track_query_rows_json",
                                     "string", ["number", "number"]);
  var _track_dump_json    = cwrap("sqlite3_track_dump_json", "string",
                                  ["number"]);

  /* ----- Statement class -------------------------------------------- */

  function Statement(stmt, db){
    this.stmt = stmt;
    this.db = db;
    this.pos = 1; /* next parameter position for positional bind */
  }

  Statement.prototype["bind"] = function bind(values){
    if( !this.stmt ) throw new Error("Statement closed");
    if( Array.isArray(values) ){
      return this.bindFromArray(values);
    }
    if( values && typeof values==="object" ){
      return this.bindFromObject(values);
    }
    return true;
  };

  Statement.prototype.bindFromArray = function(vals){
    for(var i=0;i<vals.length;i++){
      this.bindValue(vals[i], i+1);
    }
    return true;
  };

  Statement.prototype.bindFromObject = function(obj){
    for(var k in obj){
      var p = k.charAt(0)===":" || k.charAt(0)==="@" || k.charAt(0)==="$"
        ? k : ":"+k;
      var idx = sqlite3_bind_parameter_index(this.stmt, p);
      if( idx>0 ) this.bindValue(obj[k], idx);
    }
    return true;
  };

  Statement.prototype.bindValue = function(v, i){
    if( v===null || v===undefined ){
      return sqlite3_bind_null(this.stmt, i);
    }
    if( typeof v==="number" ){
      if( (v|0)===v ) return sqlite3_bind_int(this.stmt, i, v);
      return sqlite3_bind_double(this.stmt, i, v);
    }
    if( typeof v==="bigint" ){
      /* split via string for simplicity */
      return sqlite3_bind_text(this.stmt, i, v.toString(), -1, -1);
    }
    if( typeof v==="string" ){
      return sqlite3_bind_text(this.stmt, i, v, -1, -1);
    }
    if( v instanceof Uint8Array || v instanceof ArrayBuffer ){
      var u8 = v instanceof Uint8Array ? v : new Uint8Array(v);
      var ptr = _malloc(u8.length || 1);
      HEAPU8.set(u8, ptr);
      var rc = sqlite3_bind_blob(this.stmt, i, ptr, u8.length, -1);
      _free(ptr);
      return rc;
    }
    if( typeof v==="boolean" ){
      return sqlite3_bind_int(this.stmt, i, v ? 1 : 0);
    }
    throw new Error("Unsupported bind value: " + typeof v);
  };

  Statement.prototype["step"] = function step(){
    if( !this.stmt ) throw new Error("Statement closed");
    var rc = sqlite3_step(this.stmt);
    if( rc===SQLITE_ROW ) return true;
    if( rc===SQLITE_DONE ) return false;
    throw new Error("step failed: " + sqlite3_errmsg(this.db.ptr));
  };

  Statement.prototype["get"] = function get(params){
    if( params !== undefined ) this.reset(), this.bind(params);
    if( this.step() ){
      var n = sqlite3_column_count(this.stmt);
      var out = new Array(n);
      for(var i=0;i<n;i++) out[i] = this.colValue(i);
      return out;
    }
    return null;
  };

  Statement.prototype["getAsObject"] = function(params){
    if( params !== undefined ) this.reset(), this.bind(params);
    var names = this.columnNames();
    if( this.step() ){
      var obj = {};
      for(var i=0;i<names.length;i++) obj[names[i]] = this.colValue(i);
      return obj;
    }
    return null;
  };

  Statement.prototype["columnNames"] = function columnNames(){
    var n = sqlite3_column_count(this.stmt);
    var names = new Array(n);
    for(var i=0;i<n;i++) names[i] = sqlite3_column_name(this.stmt, i);
    return names;
  };

  Statement.prototype.colValue = function(i){
    var t = sqlite3_column_type(this.stmt, i);
    switch(t){
      case SQLITE_INTEGER: return sqlite3_column_double(this.stmt, i);
      case SQLITE_FLOAT:   return sqlite3_column_double(this.stmt, i);
      case SQLITE_TEXT:    return sqlite3_column_text(this.stmt, i);
      case SQLITE_BLOB: {
        var n = sqlite3_column_bytes(this.stmt, i);
        var p = sqlite3_column_blob_ptr(this.stmt, i);
        return new Uint8Array(HEAPU8.buffer, p, n).slice();
      }
      case SQLITE_NULL:
      default: return null;
    }
  };

  Statement.prototype["reset"] = function(){
    sqlite3_reset(this.stmt);
    sqlite3_clear_bindings(this.stmt);
    this.pos = 1;
    return true;
  };

  Statement.prototype["free"] = function(){
    if( this.stmt ){
      sqlite3_finalize(this.stmt);
      this.stmt = 0;
    }
    return true;
  };

  /* ----- Database class --------------------------------------------- */

  function Database(path){
    this.filename = path || ":memory:";
    var pp = stackAlloc(4);
    var rc = sqlite3_open(this.filename, pp);
    this.ptr = getValue(pp, "*");
    if( rc ){
      var msg = sqlite3_errmsg(this.ptr);
      sqlite3_close_v2(this.ptr);
      throw new Error(msg);
    }
    this.statements = [];
  }

  Database.prototype["exec"] = function(sql, params){
    if( !this.ptr ) throw new Error("Database closed");
    var results = [];
    var remain = sql;
    while( remain && remain.trim().length>0 ){
      var pp = stackAlloc(4);
      var pTail = stackAlloc(4);
      var bytes = lengthBytesUTF8(remain) + 1;
      var zSql = _malloc(bytes);
      stringToUTF8(remain, zSql, bytes);
      var rc = ccall("sqlite3_prepare_v2", "number",
        ["number", "number", "number", "number", "number"],
        [this.ptr, zSql, -1, pp, pTail]);
      if( rc!==SQLITE_OK ){
        _free(zSql);
        throw new Error(sqlite3_errmsg(this.ptr));
      }
      var stmtPtr = getValue(pp, "*");
      var tailPtr = getValue(pTail, "*");
      /* recompute remaining source string from tail pointer offset */
      var consumed = tailPtr - zSql;
      remain = UTF8ToString(tailPtr);
      _free(zSql);
      if( !stmtPtr ){
        continue;
      }
      var s = new Statement(stmtPtr, this);
      if( params ){ s.bind(params); params = null; }
      var cols = null; var rows = [];
      try {
        while( s.step() ){
          if( !cols ) cols = s.columnNames();
          var row = new Array(cols.length);
          for(var i=0;i<cols.length;i++) row[i] = s.colValue(i);
          rows.push(row);
        }
      } finally { s.free(); }
      if( cols ) results.push({columns: cols, values: rows});
    }
    return results;
  };

  Database.prototype["run"] = function(sql, params){
    return this.exec(sql, params);
  };

  Database.prototype["prepare"] = function(sql, params){
    var pp = stackAlloc(4);
    var rc = sqlite3_prepare_v2(this.ptr, sql, -1, pp, NULL);
    if( rc!==SQLITE_OK ){
      throw new Error(sqlite3_errmsg(this.ptr));
    }
    var stmt = getValue(pp, "*");
    var s = new Statement(stmt, this);
    if( params ) s.bind(params);
    this.statements.push(s);
    return s;
  };

  Database.prototype["close"] = function(){
    for(var i=0;i<this.statements.length;i++){
      try { this.statements[i].free(); } catch(e){}
    }
    this.statements = [];
    if( this.ptr ){
      sqlite3_close_v2(this.ptr);
      this.ptr = 0;
    }
  };

  /* ----- Tracking API ----------------------------------------------- */

  Database.prototype["beginTracking"] = function(){
    var rc = _track_begin(this.ptr);
    if( rc!==SQLITE_OK ) throw new Error(sqlite3_errmsg(this.ptr));
    return this;
  };

  Database.prototype["endTracking"] = function(){
    _track_end(this.ptr);
    return this;
  };

  Database.prototype["resetTracking"] = function(){
    _track_reset(this.ptr);
    return this;
  };

  Database.prototype["isTracking"] = function(){
    return !!_track_is_enabled(this.ptr);
  };

  Database.prototype["getReadLog"] = function(){
    var n = _track_read_count(this.ptr);
    var out = new Array(n);
    /* stackAlloc on a hot loop would leak frame space; save once, restore
    ** at the end. */
    var sp = stackSave();
    try {
      var pTbl = stackAlloc(4);
      var pRow = stackAlloc(8);
      var pQ   = stackAlloc(4);
      for(var i=0;i<n;i++){
        var ok = _track_read_get(this.ptr, i, pTbl, pRow, pQ);
        if( !ok ){ out[i] = null; continue; }
        var tblPtr = getValue(pTbl, "*");
        var tbl = tblPtr ? UTF8ToString(tblPtr) : null;
        var lo = getValue(pRow, "i32");
        var hi = getValue(pRow+4, "i32");
        /* Reconstruct i64. hi*2^32 + (lo>>>0) works down to the i32-min
        ** case: hi=-1, lo<0 gives lo (sign-extended via multiplication). */
        var combined = hi * 4294967296 + (lo >>> 0);
        var rowid = Number.isSafeInteger(combined)
          ? combined
          : (BigInt(hi) << 32n) | BigInt(lo >>> 0);
        var q = getValue(pQ, "i32");
        out[i] = {table: tbl, rowid: rowid, query: q};
      }
    } finally {
      stackRestore(sp);
    }
    return out;
  };

  Database.prototype["getQueryLog"] = function(){
    var n = _track_query_count(this.ptr);
    var out = new Array(n);
    for(var i=0;i<n;i++){
      var sql = _track_query_sql(this.ptr, i) || "";
      var rowsJson = _track_query_rows_json(this.ptr, i) || "[]";
      var rows;
      try { rows = JSON.parse(rowsJson); } catch(e){ rows = []; }
      out[i] = {sql: sql, rows: rows};
    }
    return out;
  };

  Database.prototype["dumpTracking"] = function(){
    return _track_dump_json(this.ptr) || "{\"reads\":[],\"queries\":[]}";
  };

  /* ----- Export ----------------------------------------------------- */

  Module["Database"] = Database;
  Module["Statement"] = Statement;
};
