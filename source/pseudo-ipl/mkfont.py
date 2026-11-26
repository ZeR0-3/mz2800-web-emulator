#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 ZeR0-3
# This file is part of the MZ-2800 Web Emulator, free software under the GNU GPL version 2 (see LICENSE).
# font8x8_basic.h (Daniel Hepper, public domain; based on IBM VGA fonts) -> font.bin (256 glyphs x 8 rows, MSB = left pixel)
import re, sys
src = open(sys.argv[1]).read()
rows = re.findall(r'\{\s*((?:0x[0-9A-Fa-f]{2}\s*,?\s*){8})\}', src)
assert len(rows) >= 128, len(rows)
out = bytearray()
for r in rows[:128]:
    bs = [int(x, 16) for x in re.findall(r'0x([0-9A-Fa-f]{2})', r)]
    out += bytes(int(f'{b:08b}'[::-1], 2) for b in bs)
for i in range(0, 0x20): out[i*8:i*8+8] = bytes(8)   # control codes: blank
out[0x7f*8:0x7f*8+8] = bytes(8)
box = bytes([0x7e, 0x42, 0x42, 0x42, 0x42, 0x42, 0x7e, 0x00])
for c in range(128, 256): out += box
open(sys.argv[2], 'wb').write(out)
print(len(out))
