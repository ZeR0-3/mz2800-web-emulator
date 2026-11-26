#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 ZeR0-3
# This file is part of the MZ-2800 Web Emulator, free software under the GNU GPL version 2 (see LICENSE).
# Build the pseudo IPL ROM (64 KB): nasm ipl.asm -> ipl.bin, prepend 0x8000 zero bytes -> IPL_pseudo.rom
import subprocess, sys, os
here = os.path.dirname(os.path.abspath(__file__))
subprocess.check_call(['nasm', '-f', 'bin', '-l', os.path.join(here, 'ipl.lst'), os.path.join(here, 'ipl.asm'), '-o', os.path.join(here, 'ipl.bin')])
b = open(os.path.join(here, 'ipl.bin'), 'rb').read()
assert len(b) == 0x8000, len(b)
rom = bytes(0x8000) + b
assert len(rom) == 0x10000 and rom[0xFFF0] == 0xEA
open(os.path.join(here, 'IPL_pseudo.rom'), 'wb').write(rom)
print('ok', len(rom))
