#!/usr/bin/env node
/* SPDX-License-Identifier: GPL-2.0-only
   Copyright (C) 2026 ZeR0-3
   This file is part of the MZ-2800 Web Emulator, free software under the GNU GPL version 2 (see LICENSE). */
/*
  MZ-2800 MCP server for the WebAssembly build (Node.js, no dependencies).

  Same tool names / arguments / output formats as the MCP server built into the desktop (Qt) emulator,
  so MCP clients can use either one.  Runs headless on a server: no Qt, no display, ROM files optional
  (the built-in pseudo IPL is used when no IPL.ROM is given).

  usage: node mz2800-mcp.js [options]
    --stdio               serve MCP on stdin/stdout (JSON lines).  Default when no --port is given.
    --port N              serve MCP over HTTP (POST /mcp).   --host ADDR (default 127.0.0.1)
    --token T             require "Authorization: Bearer T" (or env CSP_MCP_TOKEN).  Mandatory when --host is not loopback.
    --ipl F --kanji F --dict F   ROM files (all optional)
    --fd0 F --fd1 F --fd2 F --fd3 F   floppy images       --hd0 F ... --hd3 F   hard disk images
    --readonly            never write changed disk images back to the host files
    --no-realtime         advance emulation only while a tool call needs it (deterministic)
    --site DIR            directory with csp2800.js / csp2800.wasm / pseudo-ipl.rom (default ../site)
  Only stdout is the protocol channel in --stdio mode; everything else goes to stderr.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

// ------------------------------------------------------------------ options
const opt = { stdio: false, port: -1, host: '127.0.0.1', token: process.env.CSP_MCP_TOKEN || '', roms: {}, fd: [], hd: [], readonly: false, realtime: true, site: path.join(__dirname, '..', 'site') };
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i], v = () => { if (i + 1 >= a.length) die(`option ${k} needs a value`); return a[++i]; };
    if (k === '--stdio') opt.stdio = true;
    else if (k === '--port') opt.port = parseInt(v(), 10);
    else if (k === '--host') opt.host = v();
    else if (k === '--token') opt.token = v();
    else if (k === '--ipl') opt.roms.ipl = v();
    else if (k === '--kanji') opt.roms.kanji = v();
    else if (k === '--dict') opt.roms.dict = v();
    else if (/^--fd[0-3]$/.test(k)) opt.fd[+k.slice(4)] = v();
    else if (/^--hd[0-3]$/.test(k)) opt.hd[+k.slice(4)] = v();
    else if (k === '--readonly') opt.readonly = true;
    else if (k === '--no-realtime') opt.realtime = false;
    else if (k === '--site') opt.site = v();
    else if (k === '-h' || k === '--help') { console.error(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(5).join('\n')); process.exit(0); }
    else die(`unknown option ${k}`);
  }
  if (opt.port < 0) opt.stdio = true;
}
function die(m) { process.stderr.write(`mz2800-mcp: ${m}\n`); process.exit(2); }
function log(m) { process.stderr.write(`[MCP] ${m}\n`); }
const isLoop = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1';
if (opt.port >= 0 && !isLoop(opt.host) && !opt.token) die('--token (or CSP_MCP_TOKEN) is required when --host is not loopback');

// ------------------------------------------------------------------ emulator
const CHUNK = 1024, RATE = 48000, CHUNK_MS = CHUNK * 1000 / RATE;
const emu = { M: null, api: null, paused: false, busy: false, fps: 55.4, frames: 0, last: 0, files: { fd: {}, hd: {} }, pseudo: false, ready: false };

async function initEmu() {
  const createCSP = require(path.join(opt.site, 'csp2800.js'));
  const M = await createCSP({
    print: (s) => process.stderr.write(s + '\n'), printErr: (s) => process.stderr.write(s + '\n'),
    wasmBinary: fs.readFileSync(path.join(opt.site, 'csp2800.wasm')),
  });
  emu.M = M;
  const files = { ipl: 'IPL.ROM', kanji: 'KANJI.ROM', dict: 'DICT.ROM' };
  for (const [slot, name] of Object.entries(files)) {
    if (opt.roms[slot]) M.FS.writeFile('/' + name, fs.readFileSync(opt.roms[slot]));
  }
  if (!opt.roms.ipl) {
    emu.pseudo = true;
    M.FS.writeFile('/IPL.ROM', fs.readFileSync(path.join(opt.site, 'pseudo-ipl.rom')));
  }
  const c = (n, r, a) => M.cwrap(n, r, a);
  emu.api = {
    init: c('web_init', 'number', []), step: c('web_step', 'number', []), draw: c('web_draw', null, []), reset: c('web_reset', null, []),
    key: c('web_key', null, ['number', 'number', 'number']), releaseAll: c('web_key_release_all', null, []),
    typeText: c('web_type_text', null, ['string']), autoKey: c('web_auto_key_running', 'number', []),
    openFd: c('web_open_fd', 'number', ['number', 'string']), closeFd: c('web_close_fd', null, ['number']), syncFd: c('web_sync_fd', null, ['number']),
    openHd: c('web_open_hd', 'number', ['number', 'string']), closeHd: c('web_close_hd', null, ['number']),
    fdIns: c('web_fd_inserted', 'number', ['number']), fdAcc: c('web_fd_accessed', 'number', []), hdAcc: c('web_hd_accessed', 'number', []),
    pc: c('web_cpu_pc', 'number', []), read8: c('web_read8', 'number', ['number']), write8: c('web_write8', null, ['number', 'number']),
    readIo: c('web_read_io8', 'number', ['number']), out8: c('web_out8', null, ['number', 'number']),
    regs: c('web_regs', 'number', ['number', 'number']), disasm: c('web_disasm', 'number', ['number', 'number', 'number']),
    dbgAdd: c('web_dbg_add', 'number', ['number', 'number', 'number']), dbgDel: c('web_dbg_del', 'number', ['number', 'number', 'number']), dbgClear: c('web_dbg_clear', null, []),
    dbgList: c('web_dbg_list', 'number', ['number', 'number']), dbgFrozen: c('web_dbg_is_frozen', 'number', []), dbgReason: c('web_dbg_reason', 'number', ['number', 'number']),
    dbgHalt: c('web_dbg_halt', null, []), dbgStep: c('web_dbg_step', 'number', []), dbgResume: c('web_dbg_resume', 'number', []), dbgHist: c('web_dbg_history', 'number', ['number', 'number']),
    saveState: c('web_save_state', 'number', ['string']), loadState: c('web_load_state', 'number', ['string']),
    sw: c('web_screen_w', 'number', []), sh: c('web_screen_h', 'number', []), sp: c('web_screen_ptr', 'number', []), fr: c('web_frame_rate', 'number', []),
  };
  emu.api.init();
  emu.fps = emu.api.fr() || 55.4;
  for (let i = 0; i < 4; i++) {
    if (opt.fd[i]) mountFd(i, opt.fd[i], false);
    if (opt.hd[i]) mountHd(i, opt.hd[i]);
  }
  emu.ready = true;
  emu.last = Date.now();
  log(`emulator ready (${emu.pseudo ? 'built-in pseudo IPL' : 'IPL.ROM ' + opt.roms.ipl})`);
}

// ---- disks (host file <-> MEMFS copy; written back when changed)
function crc(buf) { let h = 0; for (let i = 0; i < buf.length; i += 7) h = (h * 31 + buf[i]) | 0; return h ^ buf.length; }
function mountFd(drv, p, wp) {
  const data = fs.readFileSync(p);
  const m = '/fd' + drv + (path.extname(p).toLowerCase() || '.d88');
  emu.M.FS.writeFile(m, data);
  emu.api.openFd(drv, m);
  if (emu.files.fd[drv] && emu.files.fd[drv].mem !== m) { try { emu.M.FS.unlink(emu.files.fd[drv].mem); } catch (e) { } }
  emu.files.fd[drv] = { host: p, mem: m, sum: crc(data), wp: !!wp || opt.readonly };
  if (!emu.api.fdIns(drv)) { delete emu.files.fd[drv]; throw new Error('the emulator did not accept the image (check the path / format)'); }
}
function mountHd(drv, p) {
  const data = fs.readFileSync(p);
  const m = '/hd' + drv + (path.extname(p).toLowerCase() || '.hdd');
  emu.M.FS.writeFile(m, data);
  emu.api.openHd(drv, m);
  emu.files.hd[drv] = { host: p, mem: m, sum: crc(data), wp: opt.readonly };
}
function flushDisks(force) {
  if (!emu.ready) return;
  for (const [d, f] of Object.entries(emu.files.fd)) {
    if (f.wp) continue;
    try {
      emu.api.syncFd(+d);
      const buf = Buffer.from(emu.M.FS.readFile(f.mem));
      const s = crc(buf);
      if (s !== f.sum) { fs.writeFileSync(f.host, buf); f.sum = s; log(`wrote back FD${d}: ${f.host}`); }
    } catch (e) { log(`FD${d} write-back failed: ${e.message}`); }
  }
  for (const [d, f] of Object.entries(emu.files.hd)) {
    if (f.wp) continue;
    try {
      const buf = Buffer.from(emu.M.FS.readFile(f.mem));
      const s = crc(buf);
      if (s !== f.sum) { fs.writeFileSync(f.host, buf); f.sum = s; log(`wrote back HD${d}: ${f.host}`); }
    } catch (e) { log(`HD${d} write-back failed: ${e.message}`); }
  }
}

// ---- time
let sinceFlush = 0;
function stepChunks(n) {
  for (let i = 0; i < n; i++) { emu.api.step(); emu.frames += CHUNK_MS * emu.fps / 1000; }
  sinceFlush += n;
}
const tick = () => new Promise((r) => setImmediate(r));
// Run fast (faster than real time) for `ms` of emulated time; yields to the event loop now and then.
async function runMs(ms) {
  let n = Math.ceil(ms / CHUNK_MS);
  while (n > 0) { const k = Math.min(n, 40); stepChunks(k); n -= k; if (n > 0) await tick(); }
  emu.last = Date.now();
}
async function runFrames(f) {
  const target = emu.frames + f;
  while (emu.frames < target) { stepChunks(Math.min(40, Math.max(1, Math.ceil((target - emu.frames) * 1000 / emu.fps / CHUNK_MS)))); await tick(); }
  emu.last = Date.now();
}
// background real-time loop (x1 speed, wall-clock paced)
function startRealtime() {
  if (!opt.realtime) return;
  setInterval(() => {
    if (!emu.ready || emu.paused || emu.busy || emu.api.dbgFrozen()) { emu.last = Date.now(); return; }
    const now = Date.now();
    let due = Math.floor((now - emu.last) / CHUNK_MS);
    if (due <= 0) return;
    if (due > 20) due = 20;
    stepChunks(due);
    emu.last += due * CHUNK_MS;
    if (now - emu.last > 500) emu.last = now;
    if (sinceFlush > 400) { sinceFlush = 0; if (emu.api.fdAcc() || emu.api.hdAcc()) flushDisks(); }
  }, 10);
  setInterval(() => flushDisks(), 5000);
}

// ------------------------------------------------------------------ helpers
const hex = (v, w) => v.toString(16).toUpperCase().padStart(w, '0');
function parseAddress(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/\s+/g, '');
  if (!s) return null;
  let dec = false;
  if (s[0] === '#') { dec = true; s = s.slice(1); }
  if (!dec && s.includes(':')) {
    const [a, b] = s.split(':');
    if (!/^[0-9a-f]{1,4}$/i.test(a) || !/^[0-9a-f]{1,4}$/i.test(b)) return null;
    return parseInt(a, 16) * 16 + parseInt(b, 16);
  }
  if (!dec) { if (s[0] === '$') s = s.slice(1); else if (/^0x/i.test(s)) s = s.slice(2); else if (/h$/i.test(s)) s = s.slice(0, -1); }
  if (!s || s.length > 8) return null;
  if (!(dec ? /^[0-9]+$/ : /^[0-9a-f]+$/i).test(s)) return null;
  return parseInt(s, dec ? 10 : 16);
}
function argInt(a, k, def, lo, hi) {
  let v = a[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  v = Math.trunc(v);
  return Math.min(hi, Math.max(lo, v));
}
function parseHexBytes(s) {
  const t = String(s || '').replace(/0x/gi, '').replace(/[\s,]+/g, '');
  if (!/^([0-9a-f]{2})*$/i.test(t)) throw new Error('bad hex string (use pairs of hex digits, e.g. "B8 00 01")');
  return Buffer.from(t, 'hex');
}
function withBuf(len, fn) {
  const p = emu.M._malloc(len);
  try { return fn(p); } finally { emu.M._free(p); }
}
const cstr = (p) => { const h = emu.M.HEAPU8; let e = p; while (h[e]) e++; return Buffer.from(h.subarray(p, e)).toString('utf8'); };

// PNG (RGB) encoder
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngRgb(rgb, w, h) {
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii'); data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// keys (Windows-style VKs, as the CSP core uses)
const KEYNAMES = {
  backspace: 0x08, bs: 0x08, tab: 0x09, clear: 0x0c, enter: 0x0d, return: 0x0d, shift: 0xa0, ctrl: 0xa2, control: 0xa2, alt: 0xa4, menu: 0xa4, pause: 0x13,
  capslock: 0x14, caps: 0x14, kana: 0x15, kanji: 0x19, esc: 0x1b, escape: 0x1b, convert: 0x1c, henkan: 0x1c, nonconvert: 0x1d, muhenkan: 0x1d,
  space: 0x20, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  insert: 0x2d, ins: 0x2d, delete: 0x2e, del: 0x2e, help: 0x2f,
  'num*': 0x6a, 'num+': 0x6b, 'num-': 0x6d, 'num.': 0x6e, 'num/': 0x6f,
  ';': 0xba, ':': 0xba, '-': 0xbd, '=': 0xbd, ',': 0xbc, '.': 0xbe, '/': 0xbf, '@': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, '^': 0xde, '_': 0xe2,
};
function lookupKey(name) {
  name = name.toLowerCase();
  if (!name) return null;
  if (name.length === 1) {
    if (name >= 'a' && name <= 'z') return 0x41 + name.charCodeAt(0) - 97;
    if (name >= '0' && name <= '9') return 0x30 + name.charCodeAt(0) - 48;
  }
  let m = /^f(\d{1,2})$/.exec(name);
  if (m && +m[1] >= 1 && +m[1] <= 24) return 0x70 + +m[1] - 1;
  m = /^num(\d)$/.exec(name);
  if (m) return 0x60 + +m[1];
  if (name.startsWith('vk:')) { const v = parseAddress(name.slice(3)); return v > 0 && v < 256 ? v : null; }
  return name in KEYNAMES ? KEYNAMES[name] : null;
}
function parseCombo(spec) {
  const parts = []; let cur = '';
  for (let i = 0; i < spec.length; i++) {
    if (spec[i] === '+' && cur && i + 1 < spec.length) { parts.push(cur); cur = ''; } else cur += spec[i];
  }
  if (cur) parts.push(cur);
  if (!parts.length) throw new Error('empty key');
  return parts.map((p) => { const vk = lookupKey(p); if (vk == null) throw new Error(`unknown key name: '${p}'`); return vk; });
}

// ------------------------------------------------------------------ tools
const text = (t) => ({ content: [{ type: 'text', text: t }], isError: false });
const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
const P = (type, description) => ({ type, description });
const E = (description, values) => ({ type: 'string', description, enum: values });
const S = (properties, required) => Object.assign({ type: 'object', properties }, required ? { required } : {});

const tools = [];
function tool(name, description, inputSchema, fn) { tools.push({ name, description, inputSchema, fn }); }

tool('status', 'Machine status: running/paused, screen size, CPU PC, mounted disks.', S({}), async () => {
  const j = { machine: 'MZ-2800', config_name: 'mz2800', paused: emu.paused, frame_rate: emu.fps, pc: '0x' + hex(emu.api.pc(), 6), screen: { width: emu.api.sw(), height: emu.api.sh() },
    auto_key_running: !!emu.api.autoKey(), cpu_stopped: !!emu.api.dbgFrozen(), ipl: emu.pseudo ? 'built-in pseudo IPL' : 'IPL.ROM', floppy_disks: [], hard_disks: [] };
  for (let i = 0; i < 4; i++) {
    const ins = !!emu.api.fdIns(i); const d = { drive: i, inserted: ins };
    if (ins && emu.files.fd[i]) { d.path = emu.files.fd[i].host; d.write_protected = emu.files.fd[i].wp; }
    j.floppy_disks.push(d);
    j.hard_disks.push({ drive: i, inserted: !!emu.files.hd[i] });
  }
  return text(JSON.stringify(j));
});

function screenshotPng() {
  emu.api.draw();
  const w = emu.api.sw(), h = emu.api.sh();
  if (w <= 0 || h <= 0) throw new Error('screen size is not set yet');
  const src = new Uint8Array(emu.M.HEAPU8.buffer, emu.api.sp(), w * h * 4);
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++) { rgb[j++] = src[i * 4]; rgb[j++] = src[i * 4 + 1]; rgb[j++] = src[i * 4 + 2]; }
  return { png: pngRgb(rgb, w, h), w, h };
}
tool('screenshot', 'Take a screenshot of the emulated screen (PNG). The machine keeps running.',
  S({ wait_ms: P('integer', 'Let this much emulated time pass before taking the picture (default 0).') }), async (a) => {
    await runMs(argInt(a, 'wait_ms', 0, 0, 60000));
    const s = screenshotPng();
    return { content: [{ type: 'image', data: s.png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `screen ${s.w}x${s.h}` }], isError: false };
  });

tool('type_text', "Type text on the emulated keyboard using the emulator's auto-key feature. Typing is slow (about 10 frames per character); the call returns when it has finished.",
  S({ text: P('string', "Text to type. '\\n' is Enter. Kanji cannot be typed; half-width kana and ASCII work (auto key)."),
      wait: P('boolean', 'Wait until the typing has finished (default true).'), settle_ms: P('integer', 'Extra emulated time to wait after typing (default 150).') }, ['text']), async (a) => {
    let t = typeof a.text === 'string' ? a.text : '';
    if (!t) return err("'text' is required");
    if (emu.api.dbgFrozen()) return err('the CPU is stopped at a breakpoint; use continue or step first');
    if (Buffer.byteLength(t) > 4096) return err("'text' is too long (max 4096 bytes)");
    t = t.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
    emu.api.typeText(t);
    if (a.wait === false) return text('typing started');
    const limit = Math.min(120000, 5000 + Buffer.byteLength(t) * 700);
    let spent = 0;
    while (emu.api.autoKey()) {
      if (spent > limit) return err('typing did not finish in time');
      await runMs(40); spent += 40;
    }
    await runMs(argInt(a, 'settle_ms', 150, 0, 10000));
    return text(`typed ${Buffer.byteLength(t)} byte(s)`);
  });

tool('press_key', 'Press / release a key on the emulated keyboard.',
  S({ key: P('string', "Key name or combination: a-z, 0-9, f1-f12, enter, esc, space, tab, bs, del, ins, home, end, up/down/left/right, shift, ctrl, kana, kanji, num0-num9, ';' '-' ',' '.' '/' '@' '[' ']' '^' '\\\\' '_', 'vk:0x41'. Combine with '+', e.g. 'ctrl+c', 'shift+f1'."),
      action: E('tap (press and release, default), down (hold), up (release).', ['tap', 'down', 'up']), hold_ms: P('integer', 'How long a tap holds the key (default 100).') }, ['key']), async (a) => {
    const spec = typeof a.key === 'string' ? a.key : '';
    const action = a.action || 'tap';
    if (!spec) return err("'key' is required, e.g. \"enter\", \"f1\", \"ctrl+c\", \"a\"");
    if (!['tap', 'down', 'up'].includes(action)) return err("'action' must be tap, down or up");
    let keys; try { keys = parseCombo(spec); } catch (e) { return err(e.message); }
    const rev = keys.slice().reverse();
    const send = (ks, down) => { for (const vk of ks) emu.api.key(vk, down ? 1 : 0, 0); };
    if (action === 'down') send(keys, true);
    else if (action === 'up') send(rev, false);
    else { send(keys, true); await runMs(Math.max(argInt(a, 'hold_ms', 100, 10, 10000), 4 * CHUNK_MS)); send(rev, false); await runMs(40); }
    return text(`key ${action}: ${spec}`);
  });

tool('reset', 'Reset the machine (like pressing the reset button). Mounted disks stay mounted.',
  S({ wait_ms: P('integer', 'Let this much emulated time pass after the reset (default 0).') }), async (a) => {
    emu.api.reset();
    if (emu.api.dbgFrozen()) emu.api.dbgResume();
    await runMs(argInt(a, 'wait_ms', 0, 0, 60000));
    return text('reset done');
  });

tool('wait', 'Let emulated time pass (e.g. while the machine boots). Steps frames if the emulator is paused.',
  S({ ms: P('integer', 'Emulated milliseconds to wait.'), frames: P('integer', 'Frames to wait.') }), async (a) => {
    const ms = argInt(a, 'ms', 0, 0, 120000), frames = argInt(a, 'frames', 0, 0, 100000);
    if (!ms && !frames) return err("give 'ms' or 'frames'");
    if (frames) await runFrames(frames);
    if (ms) await runMs(ms);
    return text('waited');
  });

tool('pause', 'Pause the emulation.', S({}), async () => { emu.paused = true; return text('paused'); });
tool('resume', 'Resume the emulation.', S({}), async () => { emu.paused = false; emu.last = Date.now(); return text('running'); });
tool('step_frames', 'Pause (if running) and advance the emulation by exactly N frames. Key presses are consumed while stepping. (Web build: granularity is one audio chunk, about 1.2 frames.) Use step for single instructions.',
  S({ frames: P('integer', 'Number of frames to run (1-3000, default 1).') }), async (a) => {
    const n = argInt(a, 'frames', 1, 1, 3000);
    emu.paused = true;
    await runFrames(n);
    return text(`stepped ${n} frame(s); emulator is paused`);
  });

tool('read_memory', 'Read memory (or I/O ports) as the CPU sees it, without disturbing the machine.',
  S({ address: P('string', 'Hex address ("1F00", "0xA0000", "$FF"), segment:offset ("F000:FFF0"), "#123" for decimal; a JSON number is taken as decimal.'),
      length: P('integer', 'Bytes to read (1-4096, default 64).'), space: E('memory (CPU address space, default) or io (I/O ports).', ['memory', 'io']),
      format: E('hexdump (default), bytes, base64.', ['hexdump', 'bytes', 'base64']) }, ['address']), async (a) => {
    const addr = parseAddress(a.address);
    if (addr == null) return err("'address' is required (hex string such as \"1F00\" or \"F000:FFF0\", or a number)");
    const len = argInt(a, 'length', 64, 1, 4096);
    const space = a.space || 'memory';
    if (space !== 'memory' && space !== 'io') return err("'space' must be memory or io");
    const fmt = a.format || 'hexdump';
    const io = space === 'io', sp = io ? 0x10000 : 0x1000000;
    if (addr + len > sp) return err(`range exceeds the address space (0x${hex(sp - 1, 6)})`);
    const data = Buffer.alloc(len);
    for (let i = 0; i < len; i++) data[i] = (io ? emu.api.readIo(addr + i) : emu.api.read8(addr + i)) & 255;
    if (fmt === 'base64') return text(data.toString('base64'));
    if (fmt === 'bytes') return text([...data].map((b) => hex(b, 2)).join(' '));
    let out = '';
    for (let i = 0; i < len; i += 16) {
      out += hex(addr + i, 6) + ':'; let asc = '';
      for (let j = 0; j < 16; j++) {
        if (i + j < len) { const c = data[i + j]; out += ' ' + hex(c, 2); asc += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.'; } else out += '   ';
      }
      out += `  |${asc}|\n`;
    }
    return text(out);
  });

tool('write_memory', 'Write bytes to memory (or I/O ports). Be careful: this changes the running machine.',
  S({ address: P('string', 'Same address syntax as read_memory.'), bytes: P('string', 'Hex bytes, e.g. "B8 00 01 CD 21".'), space: E('memory (default) or io.', ['memory', 'io']) }, ['address', 'bytes']), async (a) => {
    const addr = parseAddress(a.address);
    if (addr == null) return err("'address' is required");
    let bytes; try { bytes = parseHexBytes(a.bytes); } catch (e) { return err('bad \'bytes\': ' + e.message); }
    if (!bytes.length) return err("'bytes' is required (hex, e.g. \"B8 00 01\")");
    if (bytes.length > 4096) return err('too many bytes (max 4096)');
    const space = a.space || 'memory';
    if (space !== 'memory' && space !== 'io') return err("'space' must be memory or io");
    const io = space === 'io', sp = io ? 0x10000 : 0x1000000;
    if (addr + bytes.length > sp) return err('range exceeds the address space');
    for (let i = 0; i < bytes.length; i++) (io ? emu.api.out8 : emu.api.write8)(addr + i, bytes[i]);
    return text(`wrote ${bytes.length} byte(s) at 0x${hex(addr, 6)}`);
  });

tool('get_registers', 'CPU registers and flags.', S({}), async () => text(withBuf(1024, (p) => { emu.api.regs(p, 1024); return cstr(p); })));

tool('disassemble', 'Disassemble CPU instructions from memory.',
  S({ address: P('string', 'Start address (default: current program counter).'), count: P('integer', 'Number of instructions (1-200, default 10).') }), async (a) => {
    const count = argInt(a, 'count', 10, 1, 200);
    let pc;
    if (a.address !== undefined) { pc = parseAddress(a.address); if (pc == null) return err("bad 'address'"); } else pc = emu.api.pc();
    let out = '';
    withBuf(256, (p) => {
      for (let i = 0; i < count; i++) {
        let len = emu.api.disasm(pc, p, 256); if (len <= 0) len = 1;
        let bytes = '';
        for (let j = 0; j < len && j < 8; j++) bytes += hex(emu.api.read8((pc + j) & 0xffffff) & 255, 2);
        out += hex(pc, 6) + ': ' + bytes.padEnd(16) + ' ' + cstr(p) + '\n';
        pc = (pc + len) & 0xffffff;
      }
    });
    return text(out);
  });

tool('insert_floppy', 'Insert a floppy disk image (.d88 etc.).',
  S({ drive: P('integer', 'Drive number, 0-based (default 0).'), path: P('string', 'Absolute path of the disk image on the machine running the emulator.'), write_protect: P('boolean', 'Write protect the disk.') }, ['path']), async (a) => {
    const drv = argInt(a, 'drive', 0, 0, 3);
    if (!a.path) return err("'path' is required (absolute path of a .d88 / .2d / ... image)");
    try { flushDisks(); mountFd(drv, a.path, a.write_protect === true); } catch (e) { return err(e.message); }
    return text(`FD${drv}: ${a.path}`);
  });
tool('eject_floppy', 'Eject a floppy disk.', S({ drive: P('integer', 'Drive number, 0-based (default 0).') }), async (a) => {
  const drv = argInt(a, 'drive', 0, 0, 3);
  flushDisks(); emu.api.closeFd(drv); delete emu.files.fd[drv];
  return text(`FD${drv} ejected`);
});
tool('insert_hdd', 'Attach a hard disk image. Reset the machine afterwards.',
  S({ drive: P('integer', 'Drive number, 0-based (default 0).'), path: P('string', 'Absolute path of the hard disk image.') }, ['path']), async (a) => {
    const drv = argInt(a, 'drive', 0, 0, 3);
    if (!a.path) return err("'path' is required (absolute path of a .hdi / .hdd image)");
    try { flushDisks(); mountHd(drv, a.path); } catch (e) { return err(e.message); }
    return text(`HD${drv}: ${a.path} (reset the machine to boot from it)`);
  });
tool('eject_hdd', 'Detach a hard disk image.', S({ drive: P('integer', 'Drive number, 0-based (default 0).') }), async (a) => {
  const drv = argInt(a, 'drive', 0, 0, 3);
  flushDisks(); emu.api.closeHd(drv); delete emu.files.hd[drv];
  return text(`HD${drv} ejected`);
});

tool('save_state', 'Save the complete machine state to a file.', S({ path: P('string', 'Absolute path of the state file.') }, ['path']), async (a) => {
  if (!a.path) return err("'path' is required");
  try {
    if (emu.api.saveState('/state.bin') !== 0) throw new Error('state files are not supported');
    fs.writeFileSync(a.path, Buffer.from(emu.M.FS.readFile('/state.bin')));
  } catch (e) { return err('saving the state failed: ' + e.message); }
  return text('state saved: ' + a.path);
});
tool('load_state', 'Restore a machine state saved by save_state. Mount the same disk images (same drives) first.', S({ path: P('string', 'Absolute path of the state file.') }, ['path']), async (a) => {
  if (!a.path) return err("'path' is required");
  try {
    emu.M.FS.writeFile('/state.bin', fs.readFileSync(a.path));
    if (emu.api.loadState('/state.bin') !== 0) throw new Error('state files are not supported');
    emu.api.releaseAll();
    await runMs(300);   // let the restored machine settle before the next key press
  } catch (e) { return err('loading the state failed: ' + e.message); }
  return text('state loaded: ' + a.path);
});

// ---- debugger: breakpoints, watchpoints, stepping, history (web build only) ----
const BP_TYPES = { execute: 0, read: 1, write: 2, io_in: 3, io_out: 4 };
const BP_NAMES = ['breakpoint', 'read watchpoint', 'write watchpoint', 'I/O read (in) breakpoint', 'I/O write (out) breakpoint'];
function stopReason() {
  const t = withBuf(64, (p) => { emu.api.dbgReason(p, 64); return cstr(p); });
  const [k, a] = t.split(' ');
  const kind = parseInt(k, 10);
  if (kind < 0) return null;
  if (kind === 5) return 'stopped';
  return `${BP_NAMES[kind]} at 0x${hex(parseInt(a, 16), kind >= 3 ? 4 : 6)}`;
}
function dasmAt(pc, count) {
  const lines = [];
  withBuf(256, (p) => {
    for (let i = 0; i < count; i++) {
      let len = emu.api.disasm(pc, p, 256); if (len <= 0) len = 1;
      let bytes = '';
      for (let j = 0; j < len && j < 8; j++) bytes += hex(emu.api.read8((pc + j) & 0xffffff) & 255, 2);
      lines.push({ pc, len, text: hex(pc, 6) + ': ' + bytes.padEnd(16) + ' ' + cstr(p), mnemonic: cstr(p) });
      pc = (pc + len) & 0xffffff;
    }
  });
  return lines;
}
const regsText = () => withBuf(1024, (p) => { emu.api.regs(p, 1024); return cstr(p).split('\n').slice(0, 2).join('\n'); });
function stopReport(reason) {
  return `${reason}\n${regsText()}\nnext:\n${dasmAt(emu.api.pc(), 3).map((l) => '  ' + l.text).join('\n')}`;
}
// Run until the CPU stops (or `ms` of emulated time pass).  Returns true when stopped.
async function runUntilStopped(ms) {
  let n = Math.ceil(ms / CHUNK_MS);
  while (n-- > 0 && !emu.api.dbgFrozen()) { stepChunks(1); if (n % 40 === 0) await tick(); }
  emu.last = Date.now();
  return !!emu.api.dbgFrozen();
}
async function ensureStopped() {
  if (emu.api.dbgFrozen()) return;
  emu.api.dbgHalt();
  stepChunks(2);
}

tool('set_breakpoint', 'Set a breakpoint (execute) or a watchpoint (memory read/write, I/O in/out). The CPU stops when it hits; use continue / step afterwards. Up to 16 per type.',
  S({ address: P('string', 'Same address syntax as read_memory (linear address for memory; I/O port number for io_in / io_out).'),
      type: E('execute (default), read, write (memory watch), io_in, io_out.', ['execute', 'read', 'write', 'io_in', 'io_out']),
      length: P('integer', 'Bytes to watch for read/write watchpoints (1-16, default 1).') }, ['address']), async (a) => {
    const addr = parseAddress(a.address);
    if (addr == null) return err("'address' is required");
    const type = a.type || 'execute';
    if (!(type in BP_TYPES)) return err('unknown type');
    const len = (type === 'read' || type === 'write') ? argInt(a, 'length', 1, 1, 16) : 1;
    const n = emu.api.dbgAdd(BP_TYPES[type], addr, len);
    if (!n) return err('no free slot (max 16 per type)');
    return text(`${type} ${type.startsWith('io') ? 'port' : 'address'} 0x${hex(addr, 6)}${len > 1 ? ' (' + len + ' bytes)' : ''} set`);
  });
tool('clear_breakpoint', 'Remove a breakpoint / watchpoint (or all of them).',
  S({ address: P('string', 'Address given to set_breakpoint. Omit together with all=true to clear everything.'), type: E('Type given to set_breakpoint (default execute).', ['execute', 'read', 'write', 'io_in', 'io_out']),
      length: P('integer', 'Same length as given to set_breakpoint (default 1).'), all: P('boolean', 'Remove every breakpoint and watchpoint.') }), async (a) => {
    if (a.all === true) { emu.api.dbgClear(); return text('all breakpoints cleared'); }
    const addr = parseAddress(a.address);
    if (addr == null) return err("give 'address' or all=true");
    const type = a.type || 'execute';
    if (!(type in BP_TYPES)) return err('unknown type');
    const n = emu.api.dbgDel(BP_TYPES[type], addr, argInt(a, 'length', 1, 1, 16));
    return text(n ? `removed ${n}` : 'no such breakpoint');
  });
tool('list_breakpoints', 'List breakpoints and watchpoints.', S({}), async () => {
  const t = withBuf(2048, (p) => { emu.api.dbgList(p, 2048); return cstr(p); }).trim();
  if (!t) return text('(none)');
  const names = ['execute', 'read', 'write', 'io_in', 'io_out'];
  return text(t.split('\n').map((l) => { const [k, ad] = l.split(' '); return `${names[+k]} 0x${ad}`; }).join('\n'));
});
tool('break', 'Stop the CPU at the next instruction (like pressing Break). Returns registers and the next instructions.', S({}), async () => {
  await ensureStopped();
  return text(stopReport('stopped (break)'));
});
tool('continue', 'Resume a stopped CPU and run until a breakpoint / watchpoint hits or the timeout passes. Returns why it stopped, registers and the next instructions.',
  S({ timeout_ms: P('integer', 'Emulated milliseconds to run before giving up (default 10000, max 120000).') }), async (a) => {
    emu.paused = false;
    emu.api.dbgResume();
    if (emu.api.dbgFrozen()) return text(stopReport(stopReason() || 'stopped'));     // the first instruction already tripped a watchpoint
    const ok = await runUntilStopped(argInt(a, 'timeout_ms', 10000, 1, 120000));
    return text(ok ? stopReport(stopReason() || 'stopped') : `still running (no breakpoint hit); PC=0x${hex(emu.api.pc(), 6)}`);
  });
tool('step', 'Execute instructions one at a time while the CPU is stopped (stops it first if it is running). Devices do not advance during a step, so it is safe for hardware-timing-sensitive code. Returns the executed instructions, registers and the next instructions.',
  S({ count: P('integer', 'Number of instructions (1-1000, default 1).'), over: P('boolean', 'Step over call / int / loop / rep (run until the instruction after it), default false.'), timeout_ms: P('integer', 'For over=true: emulated ms to wait (default 10000).') }), async (a) => {
    await ensureStopped();
    const count = argInt(a, 'count', 1, 1, 1000);
    const done = []; let reason = null;
    for (let i = 0; i < count; i++) {
      const [ins] = dasmAt(emu.api.pc(), 1);
      if (done.length < 50) done.push(ins.text);
      if (a.over === true && /^(call|lcall|int|into|loop\w*|rep\w*)\b/i.test(ins.mnemonic)) {
        const target = (ins.pc + ins.len) & 0xffffff;
        const had = withBuf(2048, (p) => { emu.api.dbgList(p, 2048); return cstr(p); }).split('\n').some((l) => l === '0 ' + target.toString(16).toUpperCase());
        if (!had) emu.api.dbgAdd(0, target, 1);
        emu.api.dbgResume();
        const stopped = emu.api.dbgFrozen() ? true : await runUntilStopped(argInt(a, 'timeout_ms', 10000, 1, 120000));
        const r = stopReason();
        if (!had) emu.api.dbgDel(0, target, 1);
        if (!stopped) { return text(`step over: still running after the timeout; PC=0x${hex(emu.api.pc(), 6)}`); }
        if (emu.api.pc() !== target) { reason = r; break; }
      } else {
        emu.api.dbgStep();
        const r = stopReason();
        if (r && r !== 'stopped') { reason = r; break; }
      }
    }
    return text(`executed:\n${done.map((l) => '  ' + l).join('\n')}\n${stopReport(reason || 'stepped')}`);
  });
tool('history', 'The most recently executed instructions (oldest first), useful after a breakpoint hit to see how the CPU got there.',
  S({ count: P('integer', 'Number of instructions (1-500, default 30).') }), async (a) => {
    const n = argInt(a, 'count', 30, 1, 500);
    const addrs = withBuf(4 * n, (p) => { const c = emu.api.dbgHist(p, n); return [...new Uint32Array(emu.M.HEAPU8.buffer, p, c)]; });
    if (!addrs.length) return text('(no history)');
    const lines = addrs.reverse().map((pc) => dasmAt(pc, 1)[0].text);
    return text(lines.join('\n'));
  });

// ------------------------------------------------------------------ MCP (JSON-RPC 2.0)
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'MZ-2800 emulator (WebAssembly build). Debugging: set_breakpoint -> continue -> get_registers / read_memory / step / history. Typical flow: insert_floppy -> reset -> wait (boot) -> screenshot -> type_text / press_key -> screenshot. To inspect: pause -> step_frames -> read_memory / get_registers / disassemble. Addresses are hex strings.';
let queue = Promise.resolve();   // tool calls run one at a time
function enqueue(fn) { const r = queue.then(fn, fn); queue = r.catch(() => { }); return r; }

async function dispatch(method, params) {
  if (method === 'initialize') {
    const want = params && params.protocolVersion;
    return { protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'mz2800-web-mcp', version: '1.0.0' }, instructions: INSTRUCTIONS };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
  if (method === 'tools/call') {
    const t = tools.find((x) => x.name === (params && params.name));
    if (!t) throw rpcErr(-32602, `unknown tool: ${params && params.name}`);
    return enqueue(async () => {
      if (!emu.ready) return err('the emulator is not ready yet');
      emu.busy = true;
      try { return await t.fn((params && params.arguments) || {}); }
      catch (e) { return err(String(e && e.message || e)); }
      finally { emu.busy = false; emu.last = Date.now(); }
    });
  }
  throw rpcErr(-32601, `method not found: ${method}`);
}
function rpcErr(code, message) { const e = new Error(message); e.rpc = { code, message }; return e; }
// Returns the response object, or null for notifications.
async function handleMessage(msg) {
  if (Array.isArray(msg)) { const r = (await Promise.all(msg.map(handleMessage))).filter(Boolean); return r.length ? r : null; }
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    return msg && 'id' in msg ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'invalid request' } } : null;
  }
  if (!('id' in msg)) { return null; }       // notifications (notifications/initialized etc.)
  try { return { jsonrpc: '2.0', id: msg.id, result: await dispatch(msg.method, msg.params) }; }
  catch (e) { return { jsonrpc: '2.0', id: msg.id, error: e.rpc || { code: -32603, message: String(e.message || e) } }; }
}

function startStdio() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch (e) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); continue; }
      handleMessage(msg).then((r) => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); });
    }
  });
  process.stdin.on('end', () => { log('stdin closed'); shutdown(0); });
  log('serving on stdio');
}

function startHttp() {
  const localHost = (h) => { const n = (h || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''); return !n || isLoop(n); };
  const srv = http.createServer((req, res) => {
    const reply = (code, body, type, extra) => { res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json' }, extra || {})); res.end(body || ''); };
    const loopback = isLoop(opt.host);
    if (loopback) {   // DNS-rebinding / cross-origin protection
      let origin = req.headers.origin; let oh = '';
      try { if (origin) oh = new URL(origin).hostname; } catch (e) { oh = 'x'; }
      if (!localHost(req.headers.host) || (origin && !isLoop(oh))) return reply(403, '{"error":"forbidden host/origin"}');
    }
    if (opt.token && req.headers.authorization !== 'Bearer ' + opt.token) return reply(401, '{"error":"unauthorized"}', 'application/json', { 'WWW-Authenticate': 'Bearer' });
    const p = (req.url || '').split('?')[0];
    if (p !== '/mcp' && p !== '/') return reply(404, '{"error":"not found; use /mcp"}');
    if (req.method !== 'POST') return reply(405, '', 'text/plain', { Allow: 'POST' });
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 8 << 20) { req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      let msg; try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return reply(400, '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}'); }
      const r = await handleMessage(msg);
      if (r) reply(200, JSON.stringify(r)); else reply(202, '');
    });
  });
  srv.on('error', (e) => { log(`cannot listen on port ${opt.port}: ${e.message}`); process.exit(1); });
  srv.listen(opt.port, opt.host, () => log(`serving on http://${opt.host}:${srv.address().port}/mcp${opt.token ? ' (Bearer token required)' : ' (NO TOKEN: any local process can control the emulator)'}`));
  return srv;
}

function shutdown(code) { try { flushDisks(); } catch (e) { } process.exit(code); }
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

(async () => {
  try { await initEmu(); } catch (e) { process.stderr.write(`mz2800-mcp: cannot start the emulator: ${e.stack || e}\n`); process.exit(1); }
  startRealtime();
  if (opt.stdio) startStdio();
  if (opt.port >= 0) startHttp();
})();
