/* SPDX-License-Identifier: GPL-2.0-only
   Copyright (C) 2026 ZeR0-3
   This file is part of the MZ-2800 Web Emulator, free software under the GNU GPL version 2 (see LICENSE). */
// Smoke test for mcp/mz2800-mcp.js: boots the bundled FreeDOS sample, types a command and checks the results.
'use strict';
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), http = require('http');
const root = path.join(__dirname, '..', '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mz2800mcp-'));
const fd = path.join(dir, 'fdos.d88');
fs.writeFileSync(fd, zlib.gunzipSync(fs.readFileSync(path.join(root, 'site/samples/fdos.d88.gz'))));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

function stdioClient(args) {
  const p = spawn('node', [path.join(root, 'mcp/mz2800-mcp.js'), '--stdio', ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0; const pend = {};
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (pend[m.id]) { pend[m.id](m); delete pend[m.id]; } } });
  const call = (method, params) => new Promise((r) => { const i = ++id; pend[i] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const tool = async (name, args) => (await call('tools/call', { name, arguments: args || {} })).result;
  return { p, call, tool };
}
(async () => {
  const c = stdioClient(['--fd0', fd, '--readonly']);
  const init = (await c.call('initialize', { protocolVersion: '2025-06-18' })).result;
  ok(init.serverInfo.name === 'mz2800-web-mcp', 'initialize');
  const names = (await c.call('tools/list')).result.tools.map((t) => t.name);
  ok(names.length === 26, `tools/list (${names.length} tools)`);
  await c.tool('reset', { wait_ms: 60000 });
  await c.tool('wait', { ms: 30000 });
  ok((await c.tool('type_text', { text: 'ver\n' })).isError === false, 'type_text');
  await c.tool('wait', { ms: 2000 });
  const shot = await c.tool('screenshot');
  ok(shot.content[0].type === 'image' && Buffer.from(shot.content[0].data, 'base64').subarray(1, 4).toString() === 'PNG', 'screenshot is a PNG');
  const mem = (await c.tool('read_memory', { address: 'F4000', length: 16, format: 'bytes' })).content[0].text;
  ok(/^[0-9A-F]{2}( [0-9A-F]{2}){15}$/.test(mem), 'read_memory ' + mem);
  ok(/AX=[0-9A-F]{4}/.test((await c.tool('get_registers')).content[0].text), 'get_registers');
  ok(/^[0-9A-F]{6}: /.test((await c.tool('disassemble', { count: 2 })).content[0].text), 'disassemble');
  ok((await c.tool('press_key', { key: 'bogus' })).isError === true, 'press_key rejects unknown names');
  await c.tool('pause'); ok(JSON.parse((await c.tool('status')).content[0].text).paused === true, 'pause / status');
  const st = path.join(dir, 'st.bin');
  ok(!(await c.tool('save_state', { path: st })).isError && fs.statSync(st).size > 1e6, 'save_state');
  ok(!(await c.tool('load_state', { path: st })).isError, 'load_state');

  // ---- debugger ----
  await c.tool('resume');
  ok(!(await c.tool('set_breakpoint', { address: '70000' })).isError, 'set_breakpoint (execute)');
  ok((await c.tool('list_breakpoints')).content[0].text.includes('execute 0x70000'), 'list_breakpoints');
  await c.tool('reset');
  let r = (await c.tool('continue', { timeout_ms: 60000 })).content[0].text;
  ok(/^breakpoint at 0x070000/.test(r) && /CS=7000 IP=0000/.test(r), 'continue stops at the breakpoint: ' + r.split('\n')[0]);
  r = (await c.tool('step', { count: 3 })).content[0].text;
  ok(/executed:\n {2}070000: /.test(r) && /IP=004[0-9A-F]/.test(r), 'step 3 instructions');
  r = (await c.tool('history', { count: 4 })).content[0].text;
  ok(r.split('\n').length === 4 && /070000/.test(r), 'history');
  await c.tool('clear_breakpoint', { all: true });
  ok((await c.tool('set_breakpoint', { address: '70010', type: 'write' })).content[0].text.includes('70010'), 'set write watchpoint');
  await c.tool('reset');
  r = (await c.tool('continue', { timeout_ms: 60000 })).content[0].text;
  ok(/^write watchpoint at 0x070010/.test(r), 'continue stops at the watchpoint: ' + r.split('\n')[0]);
  await c.tool('clear_breakpoint', { all: true });
  r = (await c.tool('continue', { timeout_ms: 2000 })).content[0].text;
  ok(/still running/.test(r), 'continue without breakpoints keeps running');
  r = (await c.tool('break')).content[0].text;
  ok(/^stopped \(break\)/.test(r), 'break');
  ok(JSON.parse((await c.tool('status')).content[0].text).cpu_stopped === true, 'status.cpu_stopped');
  ok((await c.tool('type_text', { text: 'x' })).isError === true, 'type_text refuses while stopped');
  await c.tool('continue', { timeout_ms: 100 });
  c.p.stdin.end();

  // HTTP + token
  const port = 18800 + (process.pid % 100);
  const h = spawn('node', [path.join(root, 'mcp/mz2800-mcp.js'), '--port', String(port), '--token', 'tok', '--no-realtime'], { stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((r) => h.stderr.on('data', (d) => /serving on http/.test(d) && r()));
  const post = (body, hdr) => new Promise((res) => { const d = JSON.stringify(body); const q = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: Object.assign({ 'Content-Length': Buffer.byteLength(d) }, hdr) }, (x) => { let b = ''; x.on('data', (k) => b += k); x.on('end', () => res({ code: x.statusCode, body: b })); }); q.end(d); });
  ok((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, {})).code === 401, 'HTTP without token -> 401');
  ok((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer tok', Host: 'evil.example' })).code === 403, 'HTTP with foreign Host -> 403');
  ok((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer tok' })).code === 200, 'HTTP with token -> 200');
  h.kill();
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
