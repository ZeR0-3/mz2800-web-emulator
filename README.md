# MZ-2800 Web Emulator(CSP / WebAssembly)

武田利也氏の Common Source Code Project(CSP)の MZ-2800 エミュレーションを(issaUt 氏の [common_source_project-mz2500-linux](https://github.com/issaUt/common_source_project-mz2500-linux) を土台に)、そのまま WebAssembly にしてブラウザで動かすものです。
CPU(80286)・FDC・SASI・CRTC・OPN・PCM などの挙動は CSP 本体と同じコードです。ブラウザ側(画面・キー・音・ファイル入出力)だけを新しく書いています。

動作確認: ヘッドレス Chrome で、FreeDOS(FD / SASI HDD)の起動、キー入力、音声出力、×1 で実時間 100% を確認。実機との比較や他のブラウザ(Firefox / Safari)は未確認です。

## 中身

```
site/                    そのまま公開できる静的ファイル一式(ROMは含まない)
  pseudo-ipl.rom         内蔵の疑似IPL(IPL.ROM を選ばないときに使う。source/pseudo-ipl から作成)
  index.html app.js      画面・操作部
  csp2800.js .wasm       エミュレータ本体(下の source/ からビルド)
  samples/               FreeDOS の FD / HDD イメージ(GPL。ROM不要)
  serve.sh               ローカル確認用 (python3 -m http.server)
source/
  csp-web-port.patch     CSP への変更(7ファイル。sdl/ 以下が新規の OSD 層)
  build-web.sh files.txt WASM のビルド一式
  pseudo-ipl/            疑似IPL(自作の最小BIOS)のソース・フォント・ビルド
LICENSE                  GPL-2.0 全文
NOTICE.md                第三者コードの表記
third_party/             CSP のライセンス文
dist/                    サーバ不要の単一HTML(mz2800-standalone.html)
```

## 使い方

0. **サーバ不要版**: `dist/mz2800-standalone.html` をダブルクリックでブラウザに開くだけで動きます(WASM・疑似IPL・サンプルFDを埋め込んだ単一ファイル、約1.4MB。`source/make-standalone.py` で `site/` から作成)。ROM・ディスクの自動保存もそのまま使えます。
1. 通常版: `site/serve.sh` を実行して `http://localhost:8000/` を開く(`file://` では動きません。静的ホスティングならそのまま置けます)。
2. ROM がある場合は右上の「ROM」に **IPL.ROM**(64KB)と **KANJI.ROM**(256KB)を選ぶ(DICT.ROM は任意)。ページへのドラッグ&ドロップも可。ROM はこのブラウザの IndexedDB にだけ保存され、送信されません。
   **ROM が無くても動きます**: IPL.ROM を選ばないと、内蔵の「疑似IPL」(自作の最小BIOS)が FD / SASI HDD からブートします(FreeDOS-MZ2800 など。漢字・半角カナは表示されず、実機BIOSを直接呼ぶソフトは動きません。詳細は `source/pseudo-ipl/README.md`)。
3. 「FreeDOS FD を挿入」または自分のディスクイメージを選び、「電源ON」。

| 操作 | 内容 |
|--|--|
| ディスク | FD0 / FD1(D88 など)、HD0(SASI の生イメージ `.dat`)。起動中の差し替え可。HDD を変えたらリセット |
| 保存 | 書き込みは既定でこのブラウザに自動保存(後述)。「FD0 を保存 / HD0 を保存」でダウンロード |
| 速度 | ×1(音あり)〜×16(音なし)。FreeDOS の起動を待ちたくないときは ×8 くらいで起動し、プロンプトが出たら ×1 に戻す |
| キー | 画面をクリックで入力有効。US / JIS どちらのキーボードでも、打った文字に対応する MZ-2800 のキーを送ります。`半角/全角`=かな漢字、`変換`/`無変換`、`PageUp/Down`=F13/F14 |
| マウス | 「マウス取り込み」(ポインタロック。Esc で解除) |
| テキスト入力 | 欄に文字列を入れて Enter(CSP のオートキー機能) |

## 未対応・制限

- プリンタ出力、ジョイスティック/ゲームパッド、ステートセーブ、CPU デバッガ、ネットワーク/MIDI は無効。
- 疑似IPLは FD / HDD ブートと FreeDOS 向けの最小限の機能だけです(漢字・カナ・グラフィック・実機BIOSの多くの機能は無し)。
- ブラウザのタブが裏に回ると、タイマー制限で音が途切れます。
- ×1 の速さは音声クロックに合わせています。端末が遅いと速度表示が 100% を下回ります。

## ビルド

emscripten が必要です(動作確認は emcc 3.1.6、Ubuntu 24.04 の `apt install emscripten`)。

```bash
./source/build-web.sh /path/to/common_source_project-mz2500-linux-master/source/src  /tmp/mz2800-build
cp /tmp/mz2800-build/out/csp2800.{js,wasm} site/
```

元のツリーは変更されません(コピーにパッチを当ててビルド)。同じソースから作ったバイナリは同梱のものとビット単位で一致します。

## 移植の中身

CSP の `vm/`(デバイス)と `emu.cpp`(エミュレーション制御)はそのまま使い、Qt / Win32 の OSD の代わりに最小の OSD(`sdl/osd.h`, `osd_web.cpp`)を差し込んでいます。

- `sdl/osd_features.inc`: Qt 版 `osd.cpp` の機能フラグ表(VM の `#define` を実行時に参照させる部分)の抜き出し
- `sdl/osd_web.cpp`: 画面バッファ、キー入力(Win32 版と同じ押下保持の扱い)、音声(`vm->create_sound` を 1024 サンプルずつ呼ぶ)
- `sdl/web_main.cpp`: JS から呼ぶ C 関数(`web_init` `web_step` `web_draw` `web_key` `web_open_fd` …)
- 既存ファイルの変更は `emu_template.h` `emu.cpp` `common.cpp` `fileio.cpp` の数行のみ

## 謝辞

- 武田利也 氏 — Common Source Code Project(エミュレーション本体)
- Artanejp 氏 / K.Ohta 氏 — CSP の Qt/Linux 移植版
- issaUt 氏 — common_source_project-mz2500-linux(このプロジェクトの土台)
- cisc 氏(fmgen)、MAME の開発者、FreeDOS Project、font8x8 の作者

詳細は `NOTICE.md`。

## ライセンス

**GNU General Public License version 2 (GPL-2.0-only)**。全文は `LICENSE`、第三者のコードの扱いは `NOTICE.md`。

- 土台の CSP(武田利也氏)と Qt/Linux 移植版(Artanejp 氏)は「GNU GPL Version 2」で配布され(「or later」の記載なし)、issaUt 氏の派生版も GPL v2 互換としています。このプロジェクトはそのビルド(WebAssembly)と改変を含むため GPL v2 で公開します。新規に書いた部分(`site/`、`source/pseudo-ipl/`、`sdl/` の OSD 層など)も同じ GPL-2.0-only です(各ファイル先頭に SPDX 表記)。
- WebAssembly(`site/csp2800.wasm`)の**対応するソース**は、CSP 本体 + `source/csp-web-port.patch` + `source/build-web.sh` です(下の「ビルド」)。
- FreeDOS のサンプルイメージ(`site/samples/`)は GPL-2.0-or-later で、ソースは https://github.com/ZeR0-3/freedos-mz2800 にあります。`site/samples/FREEDOS-NOTICE.md` と `FREEDOS-LICENSE.txt` を参照。
- シャープの ROM と、ROM を逆アセンブルした内容は含みません。疑似IPLは自作、フォントは font8x8_basic(パブリックドメイン)です。

## ビルド

```
# 1. CSP のソースツリー(mz2500-linux/macOS 派生で確認)を用意し、
#    source/src を渡す(emscripten が必要。確認は emcc 3.1.6)
source/build-web.sh /path/to/common_source_project-.../source/src
# 2. できた csp2800.js / csp2800.wasm を site/ に置く
# 3. 疑似IPL: python3 source/pseudo-ipl/build.py (nasm が必要)
# 4. 単一HTML: python3 source/make-standalone.py site dist/mz2800-standalone.html
```

## ディスクの自動保存
ディスクの書き込みは、既定でこのブラウザの IndexedDB に自動保存され(約4秒ごと・タブを閉じる時)、次回ページを開くと復元されます。チェックボックスで切り替えでき、「保存したディスクを消す」で破棄できます。HDD は書き込みのたびに、FD は4秒ごとのチェックでイメージへ書き戻して保存します(CSP は本来 FD を取り出すときにしか書き戻さないため、web 版では `web_sync_fd` で取り出さずに書き戻しています)。ブラウザのデータを消すと失われるので、大事なものは「FD0/HD0 を保存」でダウンロードしてください。


## ソフトウェアキーボード(スマホ/タブレット)

画面の下に MZ-2800 配列のキーボードを表示します(タッチ端末では初回から表示、PCでは「⌨ ソフトキーボード」ボタンで開閉)。
SHIFT / CTRL はタップでラッチ(次の1キーだけ有効)。F1-F10・DEL・HOME・矢印・GRPH・CAPS 付き。
端末のネイティブキーボードは出ません(ボタン操作のみ)。
