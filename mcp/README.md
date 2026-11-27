# MZ-2800 MCP サーバー(WebAssembly 版 / Node.js)

Claude などの MCP クライアントから、Web 版と同じエミュレータ(WASM)を操作するサーバーです。
**デスクトップ版(Qt)に内蔵の MCP と同じツール名・引数・出力形式**なので、クライアント側は同じ呼び方で使えます。
Qt も画面も不要なので、サーバーでそのまま動かせます。ROM も任意(無ければ内蔵の疑似IPLで起動)。

- 必要なもの: Node.js 18 以上(22 で確認)。npm パッケージは不要(`mz2800-mcp.js` 1ファイル)。
- 同梱の `../site/csp2800.js` `csp2800.wasm` `pseudo-ipl.rom` を使います(`--site DIR` で変更)。

## 起動

```bash
# stdio(MCPクライアントがプロセスを起動する)
claude mcp add mz2800-web -- node /絶対パス/mcp/mz2800-mcp.js --fd0 /絶対パス/disk.d88

# HTTP(サーバーで常駐させ、後から接続する)
CSP_MCP_TOKEN=好きな合言葉 node mcp/mz2800-mcp.js --port 8800 --fd0 /絶対パス/disk.d88
claude mcp add --transport http mz2800-web http://127.0.0.1:8800/mcp --header "Authorization: Bearer 好きな合言葉"
```

JSON で書く場合: `{"mcpServers":{"mz2800-web":{"command":"node","args":["/絶対パス/mcp/mz2800-mcp.js","--fd0","/絶対パス/disk.d88"]}}}`

### オプション
| オプション | 内容 |
|---|---|
| `--stdio` | stdin/stdout で待ち受け(`--port` を付けないときの既定)。標準出力はプロトコル専用で、ログは標準エラー |
| `--port N` / `--host ADDR` | HTTP(`POST /mcp`)。既定は 127.0.0.1。`--stdio` と同時指定可 |
| `--token T`(環境変数 `CSP_MCP_TOKEN`) | `Authorization: Bearer T` を必須にする。**`--host` が 127.0.0.1 以外のときは必須** |
| `--ipl F` `--kanji F` `--dict F` | ROM(任意)。`--ipl` 無しなら疑似IPL |
| `--fd0..--fd3 F` / `--hd0..--hd3 F` | 起動時に挿入するディスクイメージ |
| `--readonly` | ディスクの変更をホストのファイルへ書き戻さない |
| `--no-realtime` | 常時動作させず、ツール呼び出しの間だけエミュレーションを進める(再現性が要るとき) |
| `--site DIR` | `csp2800.js` などのあるディレクトリ |

## ツール(基本の19個はデスクトップ版と同じ)
`status` `screenshot` `type_text` `press_key` `reset` `wait` `pause` `resume` `step_frames` `read_memory` `write_memory` `get_registers` `disassemble` `insert_floppy` `eject_floppy` `insert_hdd` `eject_hdd` `save_state` `load_state`
詳細は `claude/mcp-usage.md`(デスクトップ版の説明)と同じです。典型的な流れ: `insert_floppy` → `reset` → `wait`(起動待ち)→ `screenshot` → `type_text` / `press_key`。

## デスクトップ版との違い
- **時間**: 既定で実時間(x1)で常時動作し、`wait` / `type_text` などは実時間より速く(約6倍)進めます。`pause` 中は止まり、`wait` / `step_frames` で進めます。
- `step_frames` の刻みは音声1チャンク(約1.2フレーム)です。「きっかり N フレーム」ではなく、N フレーム以上で最小の刻みになります。
- **ディスク**: `path` は**サーバー上**のファイルです。エミュレータ内で書かれた変更は、約5秒ごと・取り出し時・終了時にそのファイルへ書き戻します(`--readonly` で無効)。書き戻しは上書きなので、大事なイメージは先にコピーしてください。
- **ステート**: `save_state` / `load_state` は同じディスクイメージ(同じドライブ)を挿した状態で使ってください(ステートにはディスクの中身は入りません)。別プロセスでも復元できます。
- 疑似IPLで動かす場合、漢字・半角カナの表示、グラフィック、OPN は使えません(`source/pseudo-ipl/README.md`)。実機の IPL.ROM / KANJI.ROM があれば `--ipl` `--kanji` で使えます。

## 安全面
メモリの書き換え、ディスクイメージの上書き、任意パスへのステート保存ができます。
HTTP は既定で 127.0.0.1 のみ待ち受けし、`Host` / `Origin` が localhost 以外の要求は拒否します。外へ公開するときは `--host 0.0.0.0` と**強い `--token`** を必ず付け、TLS を終端するリバースプロキシ(nginx / Caddy など)の背後に置いてください。


## デバッガ(Web/Node 版のみ・デスクトップ版の MCP には無い追加ツール)
ブラウザ版にも同じ機能のデバッガパネルがあります(右パネル「デバッガ」)。
AI にプログラムを書かせてデバッグするための機能です。

| ツール | 内容 |
|---|---|
| `set_breakpoint` | 実行ブレーク(`type=execute`)、メモリのリード/ライト監視(`read`/`write`、長さ 1–16 バイト)、I/O の `io_in`/`io_out`。各種類 16 個まで |
| `clear_breakpoint` / `list_breakpoints` | 削除(`all=true` で全削除)/ 一覧 |
| `continue` | 停止中の CPU を再開し、ブレークするか `timeout_ms` が経つまで実行。停止理由・レジスタ・次の3命令を返す |
| `break` | 次の命令境界で CPU を止める |
| `step` | 1命令ずつ実行(`count`、`over=true` で call/int/loop/rep を飛び越し)。実行した命令・レジスタ・次の命令を返す |
| `history` | 直近に実行した命令(古い順、逆アセンブル付き) |

`status` に `cpu_stopped`(CPU が停止中か)が追加されます。典型的な流れ:
`set_breakpoint 70000` → `reset` → `continue` → `get_registers` / `read_memory` / `step` / `history` → `clear_breakpoint all=true` → `continue`

注意:
- 停止は命令の境界で起こります。メモリ/I/O ウォッチは命令の完了後に報告され、表示される PC は次の命令です。
- CPU 停止中は周辺デバイスの時間は `step` では進みません(タイミングに敏感なコードでも安全)。`wait` 等でフレームを進めるとデバイスだけ動きます。
- 停止中は `type_text` を受け付けません(`continue` か `step` で先に進めてください)。常時動作モードでも停止中は進みません。
- ブレークポイントがある間はメモリアクセスの監視のため少し遅くなります。全部消すと元の速度に戻ります。
- `reset` は停止状態を解除します。

## テスト
`mcp/test/smoke.js`(stdio と HTTP で全ツールを一通り呼ぶ)。`node mcp/test/smoke.js`
