#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
# Copyright (C) 2026 ZeR0-3
# This file is part of the MZ-2800 Web Emulator, free software under the GNU GPL version 2 (see LICENSE).
"""Build a single self-contained HTML (works from file://, no server) from site/.
usage: python3 make-standalone.py <site-dir> <out.html>"""
import base64, os, re, sys
site, out = sys.argv[1], sys.argv[2]
rd = lambda p: open(os.path.join(site, p), 'rb').read()
emb = {'csp2800.wasm': rd('csp2800.wasm'), 'pseudo-ipl.rom': rd('pseudo-ipl.rom')}
for f in sorted(os.listdir(os.path.join(site, 'samples'))):
    if f.endswith('.gz'): emb['samples/' + f] = rd('samples/' + f)
items = ',\n'.join('%r:%r' % (k, base64.b64encode(v).decode()) for k, v in emb.items())
shim = """<script>
(function(){const E={%s};const of=window.fetch.bind(window);
window.fetch=function(u,o){const k=String(u).split('?')[0].replace(/^\\.\\//,'');
if(E[k]){const b=atob(E[k]),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return Promise.resolve(new Response(a,{status:200}));}
return of(u,o);};})();
</script>""" % items
html = rd('index.html').decode()
def inline(m):
    src = m.group(1)
    return '<script>' + rd(src).decode().replace('</script', '<\\/script') + '</script>'
html = re.sub(r'<script src="([^"]+)"></script>', inline, html)
html = html.replace('<script>', shim + '\n<script>', 1)
open(out, 'w', encoding='utf-8').write(html)
print(out, len(html))
