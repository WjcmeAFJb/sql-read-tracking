#!/usr/bin/env bash
# Build the native test runner using emcc targeting Node.js (WASM),
# because the host machine has no libc headers installed.
#
# Output: build/tests.js + build/tests.wasm, runnable with:
#   node build/tests.js

set -euo pipefail
cd "$(dirname "$0")/.."

EMSDK="${EMSDK:-/home/d/emsdk}"
EMCC="$EMSDK/upstream/emscripten/emcc"
export EM_CONFIG="$EMSDK/.emscripten"
export PATH="$EMSDK/upstream/emscripten:$EMSDK:$PATH"

mkdir -p build

CFLAGS=(
  -O0 -g
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
  -Ivendor -Isrc
)

echo "[1/3] Compiling sqlite3.c (one-time, may take ~30s) ..."
if [[ ! -f build/sqlite3.o || vendor/sqlite3.c -nt build/sqlite3.o ]]; then
  "$EMCC" "${CFLAGS[@]}" -c vendor/sqlite3.c -o build/sqlite3.o
else
  echo "  (cached)"
fi

echo "[2/3] Compiling track.c ..."
"$EMCC" "${CFLAGS[@]}" -c src/track.c -o build/track.o

echo "[3/3] Linking native test binary (wasm/node target) ..."
# Emcc's generated loader is CommonJS (uses `require()`). The package
# now declares "type": "module" for the ESM dist, so we emit the test
# harness with a `.cjs` extension so Node treats it as CJS regardless.
"$EMCC" "${CFLAGS[@]}" \
  -sENVIRONMENT=node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXIT_RUNTIME=1 \
  tests/native_main.c build/sqlite3.o build/track.o \
  -o build/tests.cjs

echo
echo "Built build/tests.cjs  (run: node build/tests.cjs)"
