/* SPDX-License-Identifier: GPL-2.0-only
   Copyright (C) 2026 ZeR0-3
   This file is part of the MZ-2800 Web Emulator, free software under the GNU GPL version 2 (see LICENSE). */
/*
  MZ-2800 Web Emulator front-end.
  Drives the WebAssembly build of the Common Source Code Project MZ-2800 VM.
  GPL-2.0-only.
*/
'use strict';

// ------------------------------------------------------------------ helpers
const $ = (id) => document.getElementById(id);
const ROM_SLOTS = {
  ipl:   { file: 'IPL.ROM',   need: false, size: 0x10000,  label: 'IPL.ROM',   none: '未選択(内蔵の疑似IPLで起動)' },
  kanji: { file: 'KANJI.ROM', need: false, size: 0x40000,  label: 'KANJI.ROM', none: '未選択(漢字は表示されません)' },
  dict:  { file: 'DICT.ROM',  need: false, size: 0x40000,  label: 'DICT.ROM',  none: '未選択(任意)' },
};
const state = {
  roms: {},                    // slot -> ArrayBuffer
  disks: { fd0: null, fd1: null, hd0: null },   // {name, data:Uint8Array}
  wasmBinary: null,
  M: null,                     // current Emscripten module instance
  api: null,
  running: false,
  paused: false,
  keyCapture: false,
  muted: false,
  volume: 0.7,
  speed: 1,
};

// ------------------------------------------------------------------ ROM storage (IndexedDB, this browser only)
const DB = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mz2800-web', 2);
      r.onupgradeneeded = () => { for (const n of ['roms', 'disks']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async get(key, store = 'roms') {
    try {
      const db = await this.open();
      return await new Promise((res) => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
    } catch (e) { return undefined; }
  },
  async put(key, val, store = 'roms') {
    try {
      const db = await this.open();
      return await new Promise((res) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(val, key); t.oncomplete = () => res(true); t.onerror = () => res(false); t.onabort = () => res(false); });
    } catch (e) { return false; /* private mode, quota etc. */ }
  },
  async del(key, store = 'roms') {
    try {
      const db = await this.open();
      await new Promise((res) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(key); t.oncomplete = res; t.onerror = res; });
    } catch (e) { }
  },
  async clear(store = 'roms') {
    try {
      const db = await this.open();
      await new Promise((res) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).clear(); t.oncomplete = res; t.onerror = res; });
    } catch (e) { }
  },
};

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { const u = new Uint8Array(buf); let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC_TABLE[(c ^ u[i]) & 0xFF] ^ (c >>> 8); return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0'); }

function setStatus(id, text, cls) { const e = $(id); e.textContent = text; e.className = 'state ' + (cls || ''); }

function refreshRomUi() {
  const sums = {};
  for (const slot of Object.keys(ROM_SLOTS)) if (state.roms[slot]) sums[slot] = crc32(state.roms[slot]);
  for (const [slot, def] of Object.entries(ROM_SLOTS)) {
    const buf = state.roms[slot];
    if (buf) {
      const okSize = buf.byteLength === def.size;
      const dup = Object.keys(sums).some((o) => o !== slot && sums[o] === sums[slot]);
      let txt = `${buf.byteLength.toLocaleString()} B  CRC32 ${sums[slot]}`, cls = 'ok';
      if (!okSize) { txt += `(想定 ${def.size.toLocaleString()} B)`; cls = 'warn'; }
      if (dup) { txt += ' 同じファイルが他のスロットにも選ばれています'; cls = 'bad'; }
      setStatus('st-' + slot, txt, cls);
    } else {
      setStatus('st-' + slot, def.none, '');
    }
  }
  const pseudo = !state.roms.ipl;
  $('ovStart').disabled = false;
  if (!state.running) {
    $('ovTitle').textContent = pseudo ? 'ROMなしでも起動できます' : '準備ができました';
    $('ovText').textContent = pseudo
      ? 'IPL.ROM を選ばずに「電源ON」を押すと、内蔵の疑似IPLでFD/HDDからブートします(FreeDOSなど。漢字・カナは表示されません)。ROMは右の「ROM」から選ぶか、このページへドラッグ&ドロップしてください。ROMはこのブラウザの中にだけ保存され、どこにも送信されません。'
      : '「電源ON」で起動します。FDやHDDを選んでから起動することもできます。';
  }
}

async function setRom(slot, data) {
  state.roms[slot] = data;
  await DB.put(slot, data);
  refreshRomUi();
}

// ------------------------------------------------------------------ disks
function extOf(name) { const m = /\.([A-Za-z0-9]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; }
const FD_EXT = new Set(['d88', 'd77', 'd68', 'hdm', 'tfd', 'xdf', 'dim', 'dsk', '2d', '2hd', 'fdi', 'img', 'ima', 'flp']);
const HD_EXT = new Set(['dat', 'hdd', 'hdi', 'nhd', 'sasi', 'bin']);

function updateDiskUi() {
  for (const k of ['fd0', 'fd1', 'hd0']) {
    const d = state.disks[k];
    setStatus('st-' + k, d ? `${d.name}(${(d.data.length / 1024).toFixed(0)} KB)` : '空', d ? 'ok' : '');
  }
}

function guestPath(slot, name) {
  const ext = extOf(name) || (slot.startsWith('hd') ? 'dat' : 'd88');
  return `/${slot}.${ext}`;
}

// mount into the running machine (or remember for the next power-on)
function mountDisk(slot, name, data) {
  state.disks[slot] = { name, data };
  updateDiskUi();
  storeDisk(slot);
  if (state.M) applyDisk(slot);
}
function applyDisk(slot) {
  const d = state.disks[slot], M = state.M;
  if (!M) return;
  const drv = parseInt(slot.slice(2), 10);
  const isHd = slot.startsWith('hd');
  const p = d ? guestPath(slot, d.name) : null;
  if (isHd) state.api.closeHd(drv); else state.api.closeFd(drv);
  if (!d) return;
  try { M.FS.unlink(p); } catch (e) { }
  M.FS.writeFile(p, d.data);
  if (isHd) state.api.openHd(drv, p); else state.api.openFd(drv, p);
}
function ejectDisk(slot) {
  state.disks[slot] = null;
  updateDiskUi();
  storeDisk(slot);
  if (state.M) applyDisk(slot);
}
// CSP writes a floppy image back to its file only on eject; web_sync_fd does that without ejecting
function syncFd(slot) {
  const d = state.disks[slot];
  if (!state.M || !d || !slot.startsWith('fd')) return;
  state.api.syncFd(parseInt(slot.slice(2), 10));
}
function readBackDisk(slot) {
  const d = state.disks[slot];
  if (!d) return null;
  if (state.M) {
    try { return state.M.FS.readFile(guestPath(slot, d.name)); } catch (e) { }
  }
  return d.data;
}
// ---- keep disk changes in this browser (IndexedDB 'disks')
const persist = { on: true, dirty: new Set(), busy: false, hold: {} };   // hold[slot]: extra flush cycles to keep checking after the last access
try { if (localStorage.getItem('mz2800-persist') === '0') persist.on = false; } catch (e) { }
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function storeDisk(slot) {
  const d = state.disks[slot];
  if (persist.on && d) return DB.put(slot, { name: d.name, data: d.data }, 'disks');
  if (!d) return DB.del(slot, 'disks');
}
async function flushDisks() {
  if (!persist.on || persist.busy || !state.M) return;
  persist.busy = true;
  try {
    for (const slot of [...persist.dirty]) {
      persist.dirty.delete(slot);
      const d = state.disks[slot];
      if (!d) continue;
      syncFd(slot);
      const now = readBackDisk(slot);
      if (!now) continue;
      if (sameBytes(now, d.data)) {
        if (persist.hold[slot] > 0) { persist.hold[slot]--; persist.dirty.add(slot); }   // quiet: look once or twice more
        continue;
      }
      persist.hold[slot] = 2;
      d.data = new Uint8Array(now);
      const ok = await DB.put(slot, { name: d.name, data: d.data }, 'disks');
      $('persistState').textContent = ok ? `保存済み ${new Date().toLocaleTimeString()}` : '保存できませんでした(容量不足?)';
    }
  } finally { persist.busy = false; }
}
setInterval(flushDisks, 4000);
document.addEventListener('visibilitychange', () => { if (document.hidden) { for (const k of ['fd0', 'fd1', 'hd0']) persist.dirty.add(k); flushDisks(); } });
window.addEventListener('pagehide', () => { for (const k of ['fd0', 'fd1', 'hd0']) persist.dirty.add(k); flushDisks(); });

function download(name, bytes, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function fetchMaybeGz(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ': ' + r.status);
  if (url.endsWith('.gz') && typeof DecompressionStream !== 'undefined') {
    const ds = r.body.pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return new Uint8Array(await r.arrayBuffer());
}

// ------------------------------------------------------------------ file intake (picker + drag & drop)
async function handleFile(file, hint) {
  const buf = await file.arrayBuffer();
  const up = file.name.toUpperCase();
  const ext = extOf(file.name);
  if (hint && hint in ROM_SLOTS) { await setRom(hint, buf); return; }
  if (up === 'IPL.ROM' || up.startsWith('IPL')) { await setRom('ipl', buf); return; }
  if (up === 'KANJI.ROM' || up.startsWith('KANJI')) { await setRom('kanji', buf); return; }
  if (up === 'DICT.ROM' || up.startsWith('DICT')) { await setRom('dict', buf); return; }
  const data = new Uint8Array(buf);
  if (hint && /^(fd|hd)\d$/.test(hint)) { mountDisk(hint, file.name, data); return; }
  if (HD_EXT.has(ext) && !FD_EXT.has(ext)) { mountDisk('hd0', file.name, data); return; }
  if (FD_EXT.has(ext)) { mountDisk(state.disks.fd0 ? 'fd1' : 'fd0', file.name, data); return; }
  // size heuristic: a 1.2MB image is a floppy; large raw images are hard disks
  mountDisk(data.length > 4 * 1024 * 1024 ? 'hd0' : 'fd0', file.name, data);
}

// ------------------------------------------------------------------ keyboard
// KeyboardEvent.code -> Windows virtual key (the codes the CSP MZ-2800 keyboard model expects).
// Punctuation follows the physical positions of a Japanese (JIS) keyboard.
const VK = {
  Escape: 0x1B, F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
  Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34, Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39, Digit0: 0x30,
  Minus: 0xBD, Equal: 0xDE, IntlYen: 0xDC, Backspace: 0x08, Tab: 0x09,
  BracketLeft: 0xC0, BracketRight: 0xDB, Enter: 0x0D,
  Semicolon: 0xBB, Quote: 0xBA, Backslash: 0xDD,
  Comma: 0xBC, Period: 0xBE, Slash: 0xBF, IntlRo: 0xE2,
  ShiftLeft: 0xA0, ShiftRight: 0xA1, ControlLeft: 0xA2, ControlRight: 0xA3, AltLeft: 0xA4, AltRight: 0xA5,
  Space: 0x20, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Insert: 0x2D, Delete: 0x2E, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Pause: 0x13,
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64, Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  NumpadMultiply: 0x6A, NumpadAdd: 0x6B, NumpadComma: 0x6C, NumpadSubtract: 0x6D, NumpadDecimal: 0x6E, NumpadDivide: 0x6F, NumpadEnter: 0x0D, NumpadEqual: 0x6C,
  CapsLock: 0xF0, KanaMode: 0xF1, Convert: 0x1C, NonConvert: 0x1D, Backquote: 0xF3, Lang1: 0xF1, Lang2: 0xF3, ScrollLock: 0x91,
};
for (let i = 0; i < 26; i++) VK['Key' + String.fromCharCode(65 + i)] = 0x41 + i;

const heldKeys = new Map();       // ev.code -> {vk, shifted:boolean|null} (what we sent for it)

// Printable characters -> MZ-2800 (JIS keyboard) key + whether Shift must be held.
// Using the typed character (not the physical position) makes US and JIS keyboards both work.
const CHAR_MAP = (() => {
  const m = {};
  const put = (chars, vks, shift) => { for (let i = 0; i < chars.length; i++) m[chars[i]] = [vks[i], shift]; };
  put('1234567890', [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x30], false);
  put('!"#$%&\'()', [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39], true);
  put('-^\\@[];:,./', [0xBD, 0xDE, 0xDC, 0xC0, 0xDB, 0xDD, 0xBB, 0xBA, 0xBC, 0xBE, 0xBF], false);
  put('=~|`{}+*<>?_', [0xBD, 0xDE, 0xDC, 0xC0, 0xDB, 0xDD, 0xBB, 0xBA, 0xBC, 0xBE, 0xBF, 0xE2], true);
  m['\u00a5'] = [0xDC, false];   // ¥ on JIS keyboards
  return m;
})();
let physShift = false, sentShift = false;
// A tap shorter than a few emulated frames can fall between two keyboard scans of the VM,
// so key releases are held back until enough emulated time has passed.
const MIN_HOLD_CHUNKS = 4;
const pendingUps = [];            // {vk, due, restoreShift}
function sendUp(u) {
  state.api.key(u.vk, 0, 0);
  if (u.extra) for (const m of u.extra) state.api.key(m, 0, 0);
  if (u.restoreShift) syncShift(physShift);
}
function flushUps(force) {
  for (let i = pendingUps.length - 1; i >= 0; i--) {
    if (force || loop.steps >= pendingUps[i].due) { sendUp(pendingUps[i]); pendingUps.splice(i, 1); }
  }
}
function syncShift(want) {
  if (want && !sentShift) { state.api.key(0xA0, 1, 0); sentShift = true; }
  else if (!want && sentShift) { state.api.key(0xA0, 0, 0); sentShift = false; }
}
function setKeyCapture(on) {
  state.keyCapture = on;
  $('stage').classList.toggle('active', on);
  $('focusState').textContent = on ? 'キー入力: 有効(画面の外をクリックすると解除)' : '画面をクリックするとキー入力が有効になります';
  if (!on) releaseAllKeys();
}
function releaseAllKeys() {
  heldKeys.clear(); pendingUps.length = 0; physShift = sentShift = false;
  if (state.api) state.api.releaseAll();
}
function onKey(ev, down) {
  if (!state.keyCapture || !state.api || !state.running) return;
  const t = ev.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (ev.code === 'ShiftLeft' || ev.code === 'ShiftRight') {
    ev.preventDefault();
    physShift = down;
    if (!state.paused) {
      // while a symbol key is held we may be overriding Shift; its keyup restores the physical state
      if (![...heldKeys.values()].some((h) => h.shifted !== null)) syncShift(down);
    }
    return;
  }
  const vkPhys = VK[ev.code];
  if (vkPhys === undefined) return;
  ev.preventDefault();
  if (down) {
    const rep = heldKeys.has(ev.code);
    if (state.paused) return;
    let vk = vkPhys, shifted = null;
    const ch = ev.key && ev.key.length === 1 && !ev.ctrlKey && !ev.altKey ? CHAR_MAP[ev.key] : undefined;
    if (ch) { vk = ch[0]; shifted = ch[1]; }
    if (rep) {
      const h = heldKeys.get(ev.code); vk = h.vk; shifted = h.shifted;
    } else {
      heldKeys.set(ev.code, { vk, shifted, at: loop.steps });
      // same key tapped again before its previous release went out: send the release first
      for (let i = pendingUps.length - 1; i >= 0; i--) if (pendingUps[i].vk === vk) { sendUp(pendingUps[i]); pendingUps.splice(i, 1); }
    }
    if (shifted !== null) syncShift(shifted);
    state.api.key(vk, 1, rep ? 1 : 0);
  } else {
    const h = heldKeys.get(ev.code);
    heldKeys.delete(ev.code);
    const u = { vk: h ? h.vk : vkPhys, due: (h ? h.at : loop.steps) + MIN_HOLD_CHUNKS, restoreShift: !!(h && h.shifted !== null) };
    if (loop.steps >= u.due || state.paused) sendUp(u); else pendingUps.push(u);
  }
}
window.addEventListener('keydown', (e) => onKey(e, true), { capture: true });
window.addEventListener('keyup', (e) => onKey(e, false), { capture: true });
window.addEventListener('blur', releaseAllKeys);

// ------------------------------------------------------------------ software keyboard (touch)
// Keys are sent by MZ-2800 (JIS) virtual-key code. Shift / Ctrl are one-shot latches (tap, then a key).
(function () {
  const L = (label, vk, w, o) => Object.assign({ label, vk, w: w || 2 }, o || {});
  const G = (w) => ({ gap: true, w });
  const SH = { '1': '!', '2': '"', '3': '#', '4': '$', '5': '%', '6': '&', '7': "'", '8': '(', '9': ')', '0': '', '-': '=', '^': '~', '¥': '|', '@': '`', '[': '{', ']': '}', ';': '+', ':': '*', ',': '<', '.': '>', '/': '?' };
  const rows = [
    [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => L('F' + n, 0x6F + n, 2, { sp: 1 })), L('DEL', 0x2E, 2, { sp: 1 }), L('HOME', 0x24, 2, { sp: 1 })],
    [L('ESC', 0x1B, 2.4, { sp: 1 }), ...'1234567890'.split('').map((c) => L(c, c.charCodeAt(0), 2, { ch: 1 })),
     L('-', 0xBD, 2, { ch: 1 }), L('^', 0xDE, 2, { ch: 1 }), L('¥', 0xDC, 2, { ch: 1 }), L('BS', 0x08, 2.6, { sp: 1 })],
    [L('TAB', 0x09, 3, { sp: 1 }), ...'QWERTYUIOP'.split('').map((c) => L(c, c.charCodeAt(0))),
     L('@', 0xC0, 2, { ch: 1 }), L('[', 0xDB, 2, { ch: 1 }), L('↵', 0x0D, 3, { sp: 1 })],
    [L('CTRL', 0xA2, 3.4, { mod: 'ctrl', sp: 1 }), ...'ASDFGHJKL'.split('').map((c) => L(c, c.charCodeAt(0))),
     L(';', 0xBB, 2, { ch: 1 }), L(':', 0xBA, 2, { ch: 1 }), L(']', 0xDD, 2, { ch: 1 })],
    [L('SHIFT', 0xA0, 4.2, { mod: 'shift', sp: 1 }), ...'ZXCVBNM'.split('').map((c) => L(c, c.charCodeAt(0))),
     L(',', 0xBC, 2, { ch: 1 }), L('.', 0xBE, 2, { ch: 1 }), L('/', 0xBF, 2, { ch: 1 }), L('_', 0xE2, 2, { ch: 1 })],
    [L('GRPH', 0xA4, 3, { sp: 1 }), L('CAPS', 0xF0, 3, { sp: 1 }), L('SPACE', 0x20, 10), L('←', 0x25, 2.4, { sp: 1 }), L('↑', 0x26, 2.4, { sp: 1 }), L('↓', 0x28, 2.4, { sp: 1 }), L('→', 0x27, 2.4, { sp: 1 })],
  ];
  const root = $('softkb');
  const latch = { shift: false, ctrl: false };
  const els = [];
  const active = new Map();      // pointerId -> {vk, mods:[], at, el}
  for (const r of rows) {
    const div = document.createElement('div'); div.className = 'kr';
    for (const k of r) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'k' + (k.sp ? ' sp' : '');
      b.style.setProperty('--w', k.w); b.textContent = k.label; b.dataset.vk = k.vk; b.tabIndex = -1;
      b._k = k; els.push(b); div.appendChild(b);
    }
    root.appendChild(div);
  }
  function refresh() {
    for (const b of els) {
      const k = b._k;
      if (k.mod) b.classList.toggle('latch', latch[k.mod]);
      if (k.ch) b.textContent = (latch.shift && SH[k.label] !== undefined) ? (SH[k.label] || k.label) : k.label;
    }
  }
  function down(ev, b) {
    if (!state.running || !state.api || state.paused) return;
    const k = b._k;
    ev.preventDefault();
    if (k.mod) { latch[k.mod] = !latch[k.mod]; refresh(); return; }
    const mods = [];
    if (latch.shift && k.vk !== 0xA0) mods.push(0xA0);
    if (latch.ctrl) mods.push(0xA2);
    latch.shift = latch.ctrl = false; refresh();
    syncShift(false);                              // do not mix with a physical Shift state
    for (const m of mods) state.api.key(m, 1, 0);
    state.api.key(k.vk, 1, 0);
    b.classList.add('down');
    active.set(ev.pointerId, { vk: k.vk, mods, at: loop.steps, el: b });
  }
  function up(ev) {
    const a = active.get(ev.pointerId);
    if (!a) return;
    active.delete(ev.pointerId);
    a.el.classList.remove('down');
    const u = { vk: a.vk, extra: a.mods, due: a.at + MIN_HOLD_CHUNKS, restoreShift: false };
    if (!state.api) return;
    if (loop.steps >= u.due || state.paused) sendUp(u); else pendingUps.push(u);
  }
  for (const b of els) {
    b.addEventListener('pointerdown', (ev) => { try { b.setPointerCapture(ev.pointerId); } catch (e) { } down(ev, b); });
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const btn = $('softkbBtn');
  function show(on) { root.classList.toggle('show', on); btn.textContent = on ? '⌨ キーボードを隠す' : '⌨ ソフトキーボード'; try { localStorage.setItem('mz2800-softkb', on ? '1' : '0'); } catch (e) { } }
  btn.addEventListener('click', () => show(!root.classList.contains('show')));
  let pref = null; try { pref = localStorage.getItem('mz2800-softkb'); } catch (e) { }
  show(pref !== null ? pref === '1' : (window.matchMedia && matchMedia('(pointer:coarse)').matches));
})();

// ------------------------------------------------------------------ mouse (pointer lock)
let mouseButtons = 0;
function mouseLocked() { return document.pointerLockElement === $('screen'); }
document.addEventListener('pointerlockchange', () => {
  $('btnMouse').textContent = mouseLocked() ? 'マウス解放 (Esc)' : 'マウス取り込み';
  if (!mouseLocked()) { mouseButtons = 0; if (state.api) state.api.mouse(0, 0, 0); }
});
document.addEventListener('mousemove', (e) => { if (mouseLocked() && state.api) state.api.mouse(e.movementX, e.movementY, mouseButtons); });
document.addEventListener('mousedown', (e) => {
  if (!mouseLocked() || !state.api) return;
  if (e.button === 0) mouseButtons |= 1; else if (e.button === 2) mouseButtons |= 2;
  state.api.mouse(0, 0, mouseButtons); e.preventDefault();
});
document.addEventListener('mouseup', (e) => {
  if (!mouseLocked() || !state.api) return;
  if (e.button === 0) mouseButtons &= ~1; else if (e.button === 2) mouseButtons &= ~2;
  state.api.mouse(0, 0, mouseButtons); e.preventDefault();
});
document.addEventListener('contextmenu', (e) => { if (mouseLocked()) e.preventDefault(); });

// ------------------------------------------------------------------ audio + main loop
const audio = { ctx: null, gain: null, next: 0, peak: 0, underruns: 0, chunks: 0 };
function ensureAudio() {
  if (!audio.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { audio.ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { audio.ctx = new AC(); }
    audio.gain = audio.ctx.createGain();
    audio.gain.connect(audio.ctx.destination);
    applyVolume();
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => { });
}
function applyVolume() { if (audio.gain) audio.gain.gain.value = state.muted ? 0 : state.volume * state.volume; }

const loop = { steps: 0, speed: 1, chunk: 1024, rate: 48000, anchor: 0, emuT: 0, clock: 'wall', frames: 0, lastStat: 0, statFrames: 0, speed: 0, dirty: false };
window.__csp = { state, loop, audio };   // handy for debugging in the console
function clockNow() {
  if (audio.ctx && audio.ctx.state === 'running') return { t: audio.ctx.currentTime, kind: 'audio' };
  return { t: performance.now() / 1000, kind: 'wall' };
}


// ------------------------------------------------------------------ debugger (breakpoints / stepping)
const dbg = {
  frozen: false, active: false, temp: null, last: '',
  TYPES: ['実行', 'メモリ読み', 'メモリ書き', 'I/O入力', 'I/O出力'],
  withBuf(n, fn) { const M = state.M, p = M._malloc(n); try { return fn(p); } finally { M._free(p); } },
  cstr(p) { const h = state.M.HEAPU8; let e = p; while (h[e]) e++; return new TextDecoder().decode(h.subarray(p, e)); },
  hex(v, w) { return v.toString(16).toUpperCase().padStart(w || 0, '0'); },
  list() { return this.withBuf(2048, (p) => { state.api.dbgList(p, 2048); return this.cstr(p); }).split('\n').filter(Boolean).map((l) => { const [k, a, n] = l.split(' '); return { kind: +k, addr: parseInt(a, 16), len: n ? +n : 1 }; }); },
  reason() {
    const t = this.withBuf(64, (p) => { state.api.dbgReason(p, 64); return this.cstr(p); }).split(' ');
    const k = +t[0]; if (k < 0) return '';
    if (k === 5) return '中断しました';
    return this.TYPES[k] + 'ブレーク ' + this.hex(parseInt(t[1], 16), k >= 3 ? 4 : 6);
  },
  dasm(pc, count) {
    const out = [];
    this.withBuf(256, (p) => {
      for (let i = 0; i < count; i++) {
        let len = state.api.disasm(pc, p, 256); if (len <= 0) len = 1;
        let b = ''; for (let j = 0; j < len && j < 8; j++) b += this.hex(state.api.read8((pc + j) & 0xffffff) & 255, 2);
        out.push({ pc, len, mn: this.cstr(p), text: this.hex(pc, 6) + ': ' + b.padEnd(16) + ' ' + this.cstr(p) });
        pc = (pc + len) & 0xffffff;
      }
    });
    return out;
  },
  anyBp() { return this.list().length > 0; },
  onStop() {              // the CPU just stopped (breakpoint, watchpoint, step or break)
    this.frozen = true; this.active = true;
    this.last = this.reason();
    if (this.temp != null) { state.api.dbgDel(0, this.temp, 1); this.temp = null; }
    this.render();
  },
  render() {
    const box = $('dbgBox'); if (!box || !state.api) return;
    const f = state.api.dbgFrozen();
    this.frozen = !!f;
    $('dbgState').textContent = f ? ('停止中' + (this.last ? ' — ' + this.last : '')) : '実行中';
    $('dbgState').className = f ? 'stopped' : '';
    for (const id of ['dbgCont', 'dbgStep', 'dbgOver']) $(id).disabled = !f;
    $('dbgBreak').disabled = !!f;
    if (f) {
      this.withBuf(1024, (p) => { state.api.regs(p, 1024); $('dbgRegs').textContent = this.cstr(p).split('\n').slice(0, 2).join('\n'); });
      $('dbgDis').textContent = this.dasm(state.api.pc(), 8).map((l, i) => (i ? '  ' : '> ') + l.text).join('\n');
    } else { $('dbgRegs').textContent = ''; $('dbgDis').textContent = ''; }
    const l = this.list();
    $('dbgBps').innerHTML = '';
    for (const b of l) {
      const li = document.createElement('div'); li.className = 'bp';
      li.textContent = this.TYPES[b.kind] + ' ' + this.hex(b.addr, b.kind >= 3 ? 4 : 6) + (b.len > 1 ? ' (' + b.len + 'B)' : '') + ' ';
      const x = document.createElement('button'); x.textContent = '×'; x.title = '削除';
      x.addEventListener('click', () => { state.api.dbgDel(b.kind, b.addr, b.len); this.afterEdit(); });
      li.appendChild(x); $('dbgBps').appendChild(li);
    }
    if (!l.length) $('dbgBps').textContent = '(ブレークポイントなし)';
  },
  afterEdit() { this.active = this.anyBp() || this.frozen; this.render(); },
  addBp() {
    const t = +$('dbgType').value, a = parseAddr($('dbgAddr').value);
    if (a == null) { $('dbgAddr').focus(); return; }
    const n = state.api.dbgAdd(t, a, (t === 1 || t === 2) ? Math.min(16, Math.max(1, parseInt($('dbgLen').value, 10) || 1)) : 1);
    if (!n) { alert('これ以上追加できません(各種類 16 個まで)'); return; }
    this.active = true; this.render();
  },
  halt() { state.api.dbgHalt(); this.active = true; this.stepOnce(0); },
  stepOnce(n) {           // run a little so a pending halt takes effect, then show the state
    for (let i = 0; i < 4 && !state.api.dbgFrozen(); i++) state.api.step();
    this.onStop();
  },
  resume() {
    if (!this.frozen) return;
    state.api.dbgResume();
    this.frozen = !!state.api.dbgFrozen();     // stopped again immediately (a watch hit on the first instruction)
    if (this.frozen) { this.last = this.reason(); }
    else { this.last = ''; loop.anchor = 0; this.active = this.anyBp(); }
    this.render();
  },
  step() {
    if (!this.frozen) return;
    state.api.dbgStep();
    const r = this.reason(); this.last = (!r || r === '中断しました') ? '1命令実行' : r; this.render();
  },
  over() {
    if (!this.frozen) return;
    const [ins] = this.dasm(state.api.pc(), 1);
    if (!/^(call|lcall|int|into|loop\w*|rep\w*)\b/i.test(ins.mn)) return this.step();
    const target = (ins.pc + ins.len) & 0xffffff;
    if (!this.list().some((b) => b.kind === 0 && b.addr === target)) { state.api.dbgAdd(0, target, 1); this.temp = target; }
    this.resume();
  },
  history() {
    const n = 40;
    const a = this.withBuf(4 * n, (p) => { const c = state.api.dbgHist(p, n); return [...new Uint32Array(state.M.HEAPU8.buffer, p, c)]; }).reverse();
    $('dbgHist').textContent = a.length ? a.map((pc) => this.dasm(pc, 1)[0].text).join('\n') : '(履歴なし)';
  },
  dump() {
    const a = parseAddr($('dbgMemAddr').value); if (a == null) return;
    let out = '';
    for (let r = 0; r < 8; r++) {
      let h = '', c = '';
      for (let i = 0; i < 16; i++) { const v = state.api.read8((a + r * 16 + i) & 0xffffff) & 255; h += ' ' + this.hex(v, 2); c += v >= 32 && v < 127 ? String.fromCharCode(v) : '.'; }
      out += this.hex((a + r * 16) & 0xffffff, 6) + ':' + h + '  ' + c + '\n';
    }
    $('dbgMem').textContent = out;
  },
};
function parseAddr(v) {
  let s = String(v || '').replace(/\s+/g, ''); if (!s) return null;
  if (s.includes(':')) { const [a, b] = s.split(':'); if (!/^[0-9a-f]{1,4}$/i.test(a) || !/^[0-9a-f]{1,4}$/i.test(b)) return null; return parseInt(a, 16) * 16 + parseInt(b, 16); }
  if (s[0] === '$') s = s.slice(1); else if (/^0x/i.test(s)) s = s.slice(2); else if (/h$/i.test(s)) s = s.slice(0, -1);
  return /^[0-9a-f]{1,6}$/i.test(s) ? parseInt(s, 16) : null;
}

function tick() {
  if (!state.running || state.paused || !state.api) return;
  if (dbg.frozen) return;
  const turbo = state.speed > 1;
  const c = turbo ? { t: performance.now() / 1000, kind: 'wall' } : clockNow();
  if (c.kind !== loop.clock || loop.anchor === 0 || loop.speed !== state.speed) {   // (re)anchor when the clock changes
    loop.clock = c.kind; loop.speed = state.speed; loop.anchor = c.t; loop.emuT = 0; audio.next = c.t + 0.05;
  }
  const chunkDur = loop.chunk / loop.rate;
  const budgetEnd = performance.now() + (turbo ? 14 : 30);   // keep the page responsive
  let n = 0;
  // emulated time that should have elapsed by now
  const target = () => (c.t - loop.anchor) * state.speed + 0.09;
  while (loop.emuT < target() && performance.now() < budgetEnd && n < 64) {
    const frames = state.api.step();
    loop.steps++;
    if (dbg.active && state.api.dbgFrozen()) { dbg.onStop(); break; }
    if (pendingUps.length) flushUps(false);
    if (!turbo && loop.clock === 'audio' && frames > 0 && audio.ctx) scheduleAudio(frames, chunkDur);
    loop.emuT += chunkDur;
    loop.statFrames += chunkDur;
    n++;
  }
  if (loop.emuT < target() - 0.5) {                  // far behind: don't try to catch up
    loop.anchor = c.t - (loop.emuT - 0.09) / state.speed;
  }
  loop.dirty = true;
}

function scheduleAudio(frames, chunkDur) {
  const ctx = audio.ctx;
  if (audio.next < ctx.currentTime) {               // underrun: restart the stream slightly ahead
    audio.underruns++;
    audio.next = ctx.currentTime + 0.03;
    loop.anchor = audio.next - loop.emuT;
  }
  const ptr = state.api.audioPtr();
  const src = new Int16Array(state.M.HEAP16.buffer, ptr, frames * 2);
  const buf = ctx.createBuffer(2, frames, loop.rate);
  const l = buf.getChannelData(0), r = buf.getChannelData(1);
  let pk = 0;
  for (let i = 0; i < frames; i++) { l[i] = src[i * 2] / 32768; r[i] = src[i * 2 + 1] / 32768; const a = Math.abs(src[i * 2]); if (a > pk) pk = a; }
  if (pk > audio.peak) audio.peak = pk;
  audio.chunks++;
  const node = ctx.createBufferSource();
  node.buffer = buf; node.connect(audio.gain);
  node.start(audio.next);
  audio.next += chunkDur;
}

const canvas = $('screen'), cctx = canvas.getContext('2d', { alpha: false });
let imageData = null;
function drawFrame() {
  requestAnimationFrame(drawFrame);
  if (!state.running || !state.api || !loop.dirty) return;
  loop.dirty = false;
  state.api.draw();
  const w = state.api.screenW(), h = state.api.screenH();
  const p = state.api.screenPtr();
  if (!p || !w || !h) return;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; imageData = null; }
  const px = new Uint8ClampedArray(state.M.HEAPU8.buffer, p, w * h * 4);
  if (!imageData || imageData.width !== w) imageData = new ImageData(w, h);
  imageData.data.set(px);
  cctx.putImageData(imageData, 0, 0);
}

setInterval(() => {
  if (!state.running || !state.api) return;
  const now = performance.now();
  const dt = (now - loop.lastStat) / 1000;
  if (dt >= 0.5) {
    const sp = loop.statFrames / dt;
    $('speed').textContent = state.paused ? '一時停止中' : `速度 ${(sp * 100).toFixed(0)}%${(loop.clock === 'audio' && state.speed === 1) ? '' : '(音なし)'}`;
    loop.statFrames = 0; loop.lastStat = now;
  }
  const fa = !!state.api.fdAccessed(), ha = !!state.api.hdAccessed();
  $('ledFd').classList.toggle('on', fa);
  $('ledHd').classList.toggle('on', ha);
  if (fa) { persist.dirty.add('fd0'); persist.dirty.add('fd1'); }
  if (ha) persist.dirty.add('hd0');
}, 100);
setInterval(tick, 8);

// ------------------------------------------------------------------ power on / reset
async function loadWasm() {
  if (state.wasmBinary) return;
  const r = await fetch('csp2800.wasm');
  if (!r.ok) throw new Error('csp2800.wasm: ' + r.status);
  state.wasmBinary = await r.arrayBuffer();
}

async function powerOn() {
  $('ovStart').disabled = true;
  $('ovTitle').textContent = '起動中…';
  try {
    await loadWasm();
    ensureAudio();
    const M = await createCSP({ wasmBinary: state.wasmBinary, print: () => { }, printErr: (s) => console.warn(s) });
    // ROMs must exist before the VM is created (they are read at start-up)
    for (const [slot, def] of Object.entries(ROM_SLOTS)) {
      if (state.roms[slot]) M.FS.writeFile('/' + def.file, new Uint8Array(state.roms[slot]));
    }
    state.pseudoIpl = !state.roms.ipl;
    if (state.pseudoIpl) {
      // no IPL.ROM: use the built-in pseudo IPL (see source/pseudo-ipl)
      const pr = await fetch('pseudo-ipl.rom');
      if (!pr.ok) throw new Error('pseudo-ipl.rom: ' + pr.status);
      M.FS.writeFile('/IPL.ROM', new Uint8Array(await pr.arrayBuffer()));
    }
    const cw = M.cwrap.bind(M);
    const f = {
      init: cw('web_init', 'number', []), reset: cw('web_reset', null, []),
      step: cw('web_step', 'number', []), audioPtr: cw('web_audio_ptr', 'number', []),
      draw: cw('web_draw', null, []), screenPtr: cw('web_screen_ptr', 'number', []),
      screenW: cw('web_screen_w', 'number', []), screenH: cw('web_screen_h', 'number', []),
      sndRate: cw('web_sound_rate', 'number', []), sndChunk: cw('web_sound_chunk', 'number', []),
      key: cw('web_key', null, ['number', 'number', 'number']), releaseAll: cw('web_key_release_all', null, []),
      mouse: cw('web_mouse', null, ['number', 'number', 'number']),
      typeText: cw('web_type_text', null, ['string']),
      syncFd: cw('web_sync_fd', null, ['number']), openFd: cw('web_open_fd', 'number', ['number', 'string']), closeFd: cw('web_close_fd', null, ['number']),
      openHd: cw('web_open_hd', 'number', ['number', 'string']), closeHd: cw('web_close_hd', null, ['number']),
      dbgAdd: cw('web_dbg_add', 'number', ['number', 'number', 'number']), dbgDel: cw('web_dbg_del', 'number', ['number', 'number', 'number']), dbgClear: cw('web_dbg_clear', null, []),
      dbgList: cw('web_dbg_list', 'number', ['number', 'number']), dbgFrozen: cw('web_dbg_is_frozen', 'number', []), dbgReason: cw('web_dbg_reason', 'number', ['number', 'number']),
      dbgHalt: cw('web_dbg_halt', null, []), dbgStep: cw('web_dbg_step', 'number', []), dbgResume: cw('web_dbg_resume', 'number', []), dbgHist: cw('web_dbg_history', 'number', ['number', 'number']),
      pc: cw('web_cpu_pc', 'number', []), read8: cw('web_read8', 'number', ['number']), regs: cw('web_regs', 'number', ['number', 'number']), disasm: cw('web_disasm', 'number', ['number', 'number', 'number']),
      fdAccessed: cw('web_fd_accessed', 'number', []), hdAccessed: cw('web_hd_accessed', 'number', []),
    };
    if (state.M) { releaseAllKeys(); }
    // disks must be in place before init so the very first boot sees them
    state.M = M; state.api = f;
    if (f.init() !== 0) throw new Error('web_init failed');
    for (const slot of ['fd0', 'fd1', 'hd0']) { if (state.disks[slot]) applyDisk(slot); }
    loop.rate = f.sndRate(); loop.chunk = f.sndChunk();
    loop.anchor = 0; loop.emuT = 0; loop.dirty = true; loop.lastStat = performance.now();
    if (state.pseudoIpl) setStatus('st-ipl', '内蔵の疑似IPLで動作中', 'ok');
    state.running = true; state.paused = false;
    $('btnPause').textContent = '一時停止';
    $('overlay').classList.add('hidden');
    setKeyCapture(true);
    $('stage').focus();
  } catch (e) {
    console.error(e);
    $('ovTitle').textContent = '起動に失敗しました';
    $('ovText').textContent = String(e && e.message || e) + '(file:// ではなく http:// で開いてください)';
    $('ovStart').disabled = false;
  }
}

// ------------------------------------------------------------------ wiring

// debugger panel
$('dbgBreak').addEventListener('click', () => { if (state.api) dbg.halt(); });
$('dbgCont').addEventListener('click', () => dbg.resume());
$('dbgStep').addEventListener('click', () => dbg.step());
$('dbgOver').addEventListener('click', () => dbg.over());
$('dbgAddBp').addEventListener('click', () => { if (state.api) dbg.addBp(); });
$('dbgClearAll').addEventListener('click', () => { if (state.api) { state.api.dbgClear(); dbg.resume(); dbg.afterEdit(); } });
$('dbgHistBtn').addEventListener('click', () => { if (state.api) dbg.history(); });
$('dbgMemBtn').addEventListener('click', () => { if (state.api) dbg.dump(); });
$('dbgAddr').addEventListener('keydown', (e) => { if (e.key === 'Enter' && state.api) dbg.addBp(); e.stopPropagation(); });
$('dbgMemAddr').addEventListener('keydown', (e) => { if (e.key === 'Enter' && state.api) dbg.dump(); e.stopPropagation(); });
$('dbgLen').addEventListener('keydown', (e) => e.stopPropagation());
$('ovStart').addEventListener('click', powerOn);
$('btnReset').addEventListener('click', () => {
  if (!state.running) { powerOn(); return; }
  state.api.reset();
  if (dbg.frozen) { state.api.dbgResume(); dbg.last = ''; loop.anchor = 0; }
  dbg.render();
});
$('btnPause').addEventListener('click', () => {
  if (!state.running) return;
  state.paused = !state.paused;
  $('btnPause').textContent = state.paused ? '再開' : '一時停止';
  if (!state.paused) { loop.anchor = 0; }
  if (audio.ctx) { state.paused ? audio.ctx.suspend() : audio.ctx.resume(); }
});
$('btnFull').addEventListener('click', () => { const s = $('stage'); (s.requestFullscreen || s.webkitRequestFullscreen).call(s); });
$('btnMouse').addEventListener('click', () => { if (mouseLocked()) document.exitPointerLock(); else $('screen').requestPointerLock(); });
$('btnShot').addEventListener('click', () => { canvas.toBlob((b) => download('mz2800.png', b, 'image/png')); });
$('btnMute').addEventListener('click', () => { state.muted = !state.muted; $('btnMute').textContent = state.muted ? '🔇' : '🔊'; applyVolume(); });
$('speedSel').addEventListener('change', (e) => { state.speed = parseInt(e.target.value, 10); });
$('vol').addEventListener('input', (e) => { state.volume = e.target.value / 100; applyVolume(); });
$('typeText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    if (state.api && state.running) state.api.typeText($('typeText').value.replace(/\r?\n/g, '\r') + '\r');   // CSP's auto-key: CR (0x0d) = Enter, LF is ignored
    $('typeText').value = '';
  }
});
$('clearRoms').addEventListener('click', async () => { await DB.clear(); state.roms = {}; refreshRomUi(); });

for (const slot of Object.keys(ROM_SLOTS)) {
  $('f-' + slot).addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) await handleFile(f, slot); e.target.value = ''; });
}
for (const slot of ['fd0', 'fd1', 'hd0']) {
  $('f-' + slot).addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) await handleFile(f, slot); e.target.value = ''; });
  $('e-' + slot).addEventListener('click', () => ejectDisk(slot));
}
$('dl-fd0').addEventListener('click', () => { syncFd('fd0'); const b = readBackDisk('fd0'); if (b) download(state.disks.fd0.name, b); });
$('dl-hd0').addEventListener('click', () => { const b = readBackDisk('hd0'); if (b) download(state.disks.hd0.name, b); });
$('sampleFd').addEventListener('click', async () => {
  try { mountDisk('fd0', 'fdos.d88', await fetchMaybeGz('samples/fdos.d88.gz')); } catch (e) { alert('サンプルを読み込めません: ' + e.message); }
});
$('sampleFdEms').addEventListener('click', async () => {
  try { mountDisk('fd0', 'fdos-ems.d88', await fetchMaybeGz('samples/fdos-ems.d88.gz')); } catch (e) { alert('サンプルを読み込めません: ' + e.message); }
});
$('sampleHd').addEventListener('click', async () => {
  try { ejectDisk('fd0'); mountDisk('hd0', 'fdos-hdd.dat', await fetchMaybeGz('samples/fdos-hdd.dat.gz')); } catch (e) { alert('サンプルを読み込めません: ' + e.message); }
});

// drag & drop anywhere
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
window.addEventListener('drop', async (e) => { for (const f of e.dataTransfer.files) await handleFile(f); });

$('stage').addEventListener('mousedown', () => { setKeyCapture(true); });
document.addEventListener('mousedown', (e) => { if (!$('stage').contains(e.target) && !mouseLocked()) setKeyCapture(false); }, true);
$('stage').addEventListener('keydown', (e) => { if (state.keyCapture) e.stopPropagation(); });

$('persistOn').checked = persist.on;
$('persistOn').addEventListener('change', (e) => {
  persist.on = e.target.checked;
  try { localStorage.setItem('mz2800-persist', persist.on ? '1' : '0'); } catch (err) { }
  if (persist.on) { for (const k of ['fd0', 'fd1', 'hd0']) { persist.dirty.add(k); storeDisk(k); } flushDisks(); }
});
$('clearDisks').addEventListener('click', async () => { await DB.clear('disks'); $('persistState').textContent = '保存したディスクを消しました(画面上のディスクはそのまま)'; });

// boot: restore stored ROMs
(async () => {
  for (const slot of Object.keys(ROM_SLOTS)) {
    const v = await DB.get(slot);
    if (v) state.roms[slot] = v;
  }
  for (const slot of ['fd0', 'fd1', 'hd0']) {
    const v = await DB.get(slot, 'disks');
    if (v && v.data && !state.disks[slot]) state.disks[slot] = { name: v.name, data: v.data instanceof Uint8Array ? v.data : new Uint8Array(v.data) };
  }
  refreshRomUi(); updateDiskUi(); drawFrame();
  // convenience for static hosting: a "samples" folder next to the page can be used by URL (?fd=...)
})();
