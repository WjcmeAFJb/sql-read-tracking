#!/usr/bin/env bash
# Build a native shared library + test binary using the host clang.
# Used for fast iteration; see build-wasm.sh for the shipping build.

set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p build

CC="${CC:-/home/d/emsdk/upstream/bin/clang}"
CFLAGS=(
  -std=c11
  -O0 -g
  -Wno-implicit-function-declaration
  -Wno-int-conversion
  -Wno-unused-parameter
  -Wno-unused-function
  -Wno-unused-variable
  -Wno-constant-conversion
  -Wno-unused-but-set-variable
  -DSQLITE_ENABLE_COLUMN_METADATA
  -DSQLITE_OMIT_LOAD_EXTENSION
  -DSQLITE_THREADSAFE=0
  -DSQLITE_DEFAULT_MEMSTATUS=0
  -Ivendor -Isrc
)

echo "[1/3] Compiling sqlite3.c (large, may take a bit) ..."
"$CC" "${CFLAGS[@]}" -c vendor/sqlite3.c -o build/sqlite3.o

echo "[2/3] Compiling track.c ..."
"$CC" "${CFLAGS[@]}" -c src/track.c -o build/track.o

echo "[3/3] Compiling and linking test harness ..."
"$CC" "${CFLAGS[@]}" tests/native_main.c build/sqlite3.o build/track.o \
     -lm -lpthread -ldl -o build/tests

echo
echo "Built build/tests"
