#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 ZeR0-3
# This file is part of the MZ-2800 Web Emulator, free software under the GNU GPL version 2 (see LICENSE).
# Build the MZ-2800 WebAssembly module from the Common Source Code Project sources.
#
# usage: ./build-web.sh /path/to/common_source_project-.../source/src  [work-dir]
# needs: emscripten (emcc), GNU tar, patch.   Tested with emcc 3.1.6 (Ubuntu 24.04: apt install emscripten)
# result: <work-dir>/out/csp2800.js and csp2800.wasm  (copy both next to site/index.html)
set -eu
SRC_ORIG="$(cd "$1" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${2:-$HERE/work}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
mkdir -p "$WORK/src" "$WORK/obj" "$WORK/out"

# 1. copy the platform-independent part of the tree and apply the web-port patch
if [ ! -f "$WORK/src/.patched" ]; then
  (cd "$SRC_ORIG" && tar -c --exclude=./qt --exclude=./res --exclude=./win32 --exclude=./winplugin --exclude=./zlib-1.2.11 -f - .) | tar -x -C "$WORK/src"
  patch -d "$WORK/src" -p1 < "$HERE/csp-web-port.patch"
  touch "$WORK/src/.patched"
fi
SRC="$WORK/src"

# 2. compile (every object depends on sdl/osd.h, so always rebuild)
compile() {
  f="$1"; o="$WORK/obj/$(echo "$f" | tr '/' '_').o"
  emcc -std=c++14 -O2 -c "$SRC/$f" -o "$o" -D_MZ2800 -D_USE_SDL -include "$SRC/vm/vm.h" -DNDEBUG \
    -I"$SRC" -I"$SRC/vm" -I"$SRC/vm/mz2800" -I"$SRC/vm/fmgen" -I"$SRC/vm/mame" -w \
    || { echo "FAILED: $f" >&2; exit 1; }
}
export -f compile; export SRC WORK
grep -v '^#' "$HERE/files.txt" | xargs -P "$JOBS" -I{} bash -c 'compile {}'

# 3. link
OBJS=$(grep -v '^#' "$HERE/files.txt" | while read -r f; do echo "$WORK/obj/$(echo "$f" | tr '/' '_').o"; done)
emcc -O2 $OBJS -o "$WORK/out/csp2800.js" \
  -s MODULARIZE=1 -s EXPORT_NAME=createCSP -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=67108864 \
  -s EXPORTED_RUNTIME_METHODS='["FS","HEAPU8","HEAP16","cwrap","ccall"]' -s FORCE_FILESYSTEM=1 \
  -s ENVIRONMENT=web,worker,node
echo "built: $WORK/out/csp2800.js  $WORK/out/csp2800.wasm"
