#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 ZeR0-3
# This file is part of the MZ-2800 Web Emulator, free software under the GNU GPL version 2 (see LICENSE).
# The page must be opened over http:// (not file://). Then browse to http://localhost:8000/
cd "$(dirname "$0")" && python3 -m http.server 8000
