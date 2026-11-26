# NOTICE / 第三者コード

このリポジトリ全体は GPL-2.0-only(`LICENSE`)で配布します。含まれる/ビルドに使うもの:

| 対象 | 由来 | ライセンス |
|---|---|---|
| `site/csp2800.wasm` `csp2800.js` の元ソース | issaUt 氏の [common_source_project-mz2500-linux](https://github.com/issaUt/common_source_project-mz2500-linux)(MZ-2500 向け Linux/WSL 派生。このプロジェクトの土台)← Artanejp 氏 / K.Ohta 氏の Qt/Linux 移植版(common_source_project-fm7)← 武田利也 氏の Common Source Code Project。改変は `source/csp-web-port.patch` | GNU GPL Version 2(`third_party/CSP-LICENSE.txt`)。上流の CSP・Artanejp 版はいずれも「GPLv2」で、「or later」の記載なし。issaUt 版の README も「GPL v2 互換」としている |
| `source/csp-web-port.patch` で追加した `sdl/` | このプロジェクト(`sdl/osd_features.inc` は CSP の Qt 版 `osd.cpp` の機能フラグ表の抜き出し) | GPL-2.0-only |
| CSP 内の `vm/fmgen/` | cisc 氏 (C) 1998, 2003。CSP に同梱され WASM に含まれる | 独自条件(`vm/fmgen/readme.txt`: フリーソフトとして配布すること、商用ソフトでの使用は要許可、ソース配布時は注記を改変しない等)。**商用利用する場合は要確認** |
| CSP 内の MAME 由来コード(i286 など) | MAME 開発者 | 各ファイルのヘッダに従う |
| `site/app.js` `site/index.html` `source/pseudo-ipl/ipl.asm` ほか | このプロジェクト | GPL-2.0-only |
| `source/pseudo-ipl/font8x8_basic.h` `font.bin` | Daniel Hepper / Marcel Sondaar / IBM VGA フォント | パブリックドメイン |
| `site/samples/*`(FreeDOS-MZ2800 の FD / HDD イメージ) | FreeDOS kernel / FreeCOM に MZ-2800 向け変更を加えたもの | GPL-2.0-or-later(`site/samples/FREEDOS-NOTICE.md`, `FREEDOS-LICENSE.txt`)。FreeDOS 本家: https://github.com/FDOS/kernel , https://github.com/FDOS/freecom |

## 含まないもの
- シャープの IPL.ROM / KANJI.ROM / DICT.ROM。利用者が各自用意します(ブラウザの IndexedDB にだけ保存)。
- ROM の逆アセンブル結果。疑似IPLはそれらを使わずに書いた最小実装です。

## サンプルイメージの対応ソース(GPL 第3条)
`site/samples/` の FreeDOS イメージの対応ソースは、MZ-2800 移植版リポジトリ https://github.com/ZeR0-3/freedos-mz2800 にあります(GPL-2.0-or-later)。
- `patches/kernel-mz2800.patch` / `patches/freecom-mz2800.patch` — FreeDOS kernel / FreeCOM への変更
- `loader/` `drivers/` `tests/` `config/` — ローダ・ドライバ等
- FreeDOS 本家: https://github.com/FDOS/kernel , https://github.com/FDOS/freecom

## 謝辞 / Acknowledgements
- **武田利也(Toshiya Takeda)氏** — Common Source Code Project(CSP)の作者。MZ-2800 を含む多数の機種のエミュレーションコード(`vm/`、`emu.cpp`)は氏の作品です。
- **Artanejp 氏 / K.Ohta 氏** — CSP の Qt/Linux 移植版(common_source_project-fm7)。
- **issaUt 氏** — MZ-2500 向け Linux/WSL 実用化派生(common_source_project-mz2500-linux)。このプロジェクトはこのリポジトリを土台にしています。
- **cisc 氏** — FM 音源ライブラリ fmgen。**MAME の開発者**、およびその他 CSP に同梱されたコードの作者の皆さま。
- **FreeDOS Project** — kernel / FreeCOM(MZ-2800 移植は https://github.com/ZeR0-3/freedos-mz2800)。
- **Daniel Hepper 氏 / Marcel Sondaar 氏 / IBM** — font8x8(パブリックドメイン)。疑似IPLのフォントに使用。
- 大元のプログラム・音源・ハードウェア知識の蓄積を公開してくださっているすべての方々に感謝します。

注: issaUt 氏のリポジトリには最上位ではなく `source/LICENSE.txt`(GNU GPL Version 2 の全文)があり、`third_party/CSP-LICENSE.txt` はその内容と同じものです。
