# 疑似IPL(ROMなしブート用)

IPL.ROM を持っていなくても FD / SASI HDD から起動できるようにするための、**自作の最小BIOS/IPL**です。
シャープのROMのコードは一切含みません(ハードウェアの挙動は CSP のソースと、実機IPLの I/O 書き込み列の観察から書き起こしています)。

- `ipl.asm` : 本体(nasm, 16bit / 286)。リセットベクタ→ハード初期化→テキスト画面→`int 51h` 互換サービス→FD/HDDブート
- `font.bin` / `mkfont.py` / `font8x8_basic.h` : 8x8 ASCII フォント(font8x8_basic, Daniel Hepper, パブリックドメイン)
- `build.py` : `python3 build.py` で `IPL_pseudo.rom`(64KB)を作る。`site/pseudo-ipl.rom` として同梱

## できること
- FD0 / FD1(2HD, トラック0の両面16KBを 7000:0000 へ読んで起動。実機IPLと同じレジスタ・パラメータブロックで `call 7000:0000`)
- SASI HDD0(LBA0 先頭ワード 0400h → パーティション表 → 最初の起動可能な区画の16セクタを読んで起動)
- `int 51h`: 04/05(FD読み書き) 20/21(キー) 45(カーソル) 4F(スクロール) 57(1文字出力) C1/C4/C5(SASI) と、
  FreeDOS-MZ2800 の shim が使う BIOS データ(0040:0202 拡張RAM表, 0A3F カーソル, 0A48 属性)
- 80x25 テキスト、キーボード(JIS配列、Shift/CAPS/CTRL、F1-F10・カーソル・DEL・HOME)

## できないこと
- 漢字・半角カナの表示(KANJI.ROM があっても使いません。2バイト文字は□で表示)
- グラフィック画面、OPN/サウンド、タイマー割り込み、RTC設定、プリンタ、その他の `int 51h` 機能(実機BIOSを直接呼ぶソフトは動かない)
- FDブートは2HD(1024B/セクタ)のみ。起動デバイスの選択メニューや複数区画の選択はなし(FD0→FD1→HDD0 の順に探す)
