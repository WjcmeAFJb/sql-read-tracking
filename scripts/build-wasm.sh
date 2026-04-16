#!/usr/bin/env bash
# Build the shipping WASM library: dist/sqlite3-tracked.js + .wasm.
#
# Consumers use it like:
#   const init = require("sqlite3-tracked");
#   const SQL = await init();
#   const db = new SQL.Database();
#   db.beginTracking();
#   db.exec("SELECT * FROM users");
#   console.log(db.getReadLog());

set -euo pipefail
cd "$(dirname "$0")/.."

EMSDK="${EMSDK:-/home/d/emsdk}"
EMCC="$EMSDK/upstream/emscripten/emcc"
export EM_CONFIG="$EMSDK/.emscripten"
export PATH="$EMSDK/upstream/emscripten:$EMSDK:$PATH"

mkdir -p build dist

OPT="${OPT:--O2}"

CFLAGS=(
  $OPT
  -g1
  -Wno-implicit-function-declaration
  -Wno-int-conversion
  -Wno-unused-parameter
  -Wno-unused-function
  -Wno-unused-variable
  -Wno-constant-conversion
  -Wno-unused-but-set-variable
  -DSQLITE_OMIT_LOAD_EXTENSION
  -DSQLITE_THREADSAFE=0
  -DSQLITE_DEFAULT_MEMSTATUS=0
  -DSQLITE_ENABLE_COLUMN_METADATA
  -DSQLITE_ENABLE_NORMALIZE
  -DSQLITE_ENABLE_FTS5
  -DSQLITE_ENABLE_JSON1
  -Ivendor -Isrc
)

echo "[1/3] Compile sqlite3.c -> build/sqlite3.o"
if [[ ! -f build/sqlite3.o || vendor/sqlite3.c -nt build/sqlite3.o ]]; then
  "$EMCC" "${CFLAGS[@]}" -c vendor/sqlite3.c -o build/sqlite3.o
else
  echo "  (cached)"
fi

echo "[2/3] Compile track.c -> build/track.o"
"$EMCC" "${CFLAGS[@]}" -c src/track.c -o build/track.o

echo "[3/3] Link dist/sqlite3-tracked.js"
"$EMCC" "${CFLAGS[@]}" \
  -sENVIRONMENT=node,web,worker \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXIT_RUNTIME=0 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=0 \
  -sEXPORT_NAME=initSqliteTracked \
  -sSTACK_SIZE=5MB \
  -sEXPORTED_FUNCTIONS=@src/bindings/exported_functions.json \
  -sEXPORTED_RUNTIME_METHODS=@src/bindings/exported_runtime_methods.json \
  --pre-js src/bindings/api.js \
  build/sqlite3.o build/track.o \
  -o dist/sqlite3-tracked.js

cp src/bindings/sqlite3-tracked.d.ts dist/sqlite3-tracked.d.ts

ls -la dist/
echo
echo "Built dist/sqlite3-tracked.js (+ .wasm, + .d.ts)."
