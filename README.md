# youyakun（ようやくん）

YouTube の字幕を一括コピーし、そのまま Claude Code に渡して要約・質問できるブラウザ拡張（Chrome / Brave / Chromium）。
「YouTube Summary with ChatGPT & Claude」に近い使い勝手を、自分の Claude Code（Raspberry Pi 上）で動かす。

## 現状（2026-11-24）
- v0.1 を実装。ブリッジ（Pi 側）は要約・続きの質問・途中停止まで動作確認済み
- Codex レビューの指摘（停止時に Claude が残る、接続の居座り、初回の二重送信、失敗したセッション ID の保存など）は反映済み
- ブリッジを Pi に常駐済み（2026-11-24、`install.sh --tailscale`。127.0.0.1 と Pi の Tailscale IP の 8765 番）
- 接続先（ブリッジ）を複数登録して切り替えられるようにした（設定画面と YouTube のパネルの両方から）
- 拡張の字幕取得は**まだ実際の YouTube で試していない**（Pi から YouTube の API を叩くテストが自動モードで止められたため）

## しくみ
```
YouTube のページ ── content.js（パネル・字幕取得）
        │ port
   background.js（http のブリッジへ中継）
        │ HTTP + トークン（127.0.0.1 または Tailscale）
   bridge/youyakun_bridge.py（Pi で常駐）
        │ claude -p --output-format stream-json [--resume <id>]
   Claude Code
```
- 1 通目だけ字幕を付けて新しいセッションを始め、2 通目からは `--resume` で同じセッションを続ける
- セッションは Pi の `~/.local/share/youyakun/work` に保存される。パネルの「ターミナルで続けるコマンドをコピー」で、CLI から同じ会話を続けられる
- ブリッジは**道具なし**（`--tools ""`）で Claude を動かす。ネットワーク越しに呼ばれるため、ファイル操作やコマンド実行はさせない

## 機能
- 字幕をコピー（本文のみ／時刻つき）。先頭にタイトルと URL が付く
- 字幕の言語を選べる（自動生成も表示）
- 字幕の一覧表示。時刻をクリックするとその位置へ飛ぶ
- 「Claude で要約」：設定画面の指示＋字幕を Claude Code に送り、返答を少しずつ表示
- 続けて質問できる（Enter で送信／返答中は「停止」）
- 返答の中の `[12:34]` もクリックで再生位置へ飛ぶ
- 動画ごとに会話を保存。開き直すと続きから

字幕の取り方は 3 段構え：① YouTube の文字起こし API（get_transcript）→ ② 字幕ファイル（timedtext）→ ③ ページの「文字起こし」パネルを開いて読む。

## 入れ方

### 1. ブリッジ（Claude Code が動くマシン＝Pi）
Claude Code 2.1.259 以降が必要（`--permission-prompts` を使うため）。
同じ Pi のブラウザから使うだけなら:
```bash
~/Documents/01_Project/youyakun/bridge/install.sh
```
Mac など別のマシンのブラウザから Tailscale 経由で使うなら:
```bash
~/Documents/01_Project/youyakun/bridge/install.sh --tailscale
```
最後に表示されるトークンを控える（あとで `python3 ~/Documents/01_Project/youyakun/bridge/youyakun_bridge.py --print-token` でも出せる）。

- 設定: `~/.config/youyakun/config.json`（ポート、待ち受けアドレス、作業フォルダ、既定モデル、システムプロンプト）
- ログ: `journalctl --user -u youyakun-bridge -f`

### 2. 拡張機能（ブラウザ）
1. `chrome://extensions`（Brave は `brave://extensions`）を開き、右上の「デベロッパーモード」をオン
2. 「パッケージ化されていない拡張機能を読み込む」→ `extension/` フォルダを選ぶ（Mac なら Pi から `extension/` をコピーしてから）
3. ツールバーの youyakun アイコン → 設定画面で、接続先の名前・ブリッジの URL・トークンを入れて「接続を確かめる」→「保存」
   - 同じマシン: `http://127.0.0.1:8765`
   - Mac → Pi: `http://<Pi の Tailscale IP>:8765`（Pi で `tailscale ip -4` を実行すると分かる）

### 接続先の切り替え
- 設定画面の「＋ 追加」で接続先（例:「Pi（Tailscale）」「この Mac」）を増やし、「この接続先を使う」で切り替える
- 接続先が 2 つ以上あると、YouTube のパネルの上部にも切り替えのメニューが出る
- 会話は「接続先 × 動画」ごとに保存される。セッションはブリッジのマシンにあるため、接続先を変えると、その接続先での会話に切り替わる
- 別のマシンを接続先にするときは、そのマシンにもこのリポジトリを置いて `bridge/install.sh` を実行する（Claude Code が入っていること）

## 次にやること
- [ ] 実際の YouTube で字幕取得（3 つの方法それぞれ）を確認する
  - Codex の指摘: 最近の YouTube は文字起こしパネルを `get_panel` で読む新しい形になっていることがあり、そのときは①が失敗する。②も PO Token が必要な動画では空になる。③（ページのパネル）が頼りなので、パネルの要素名が変わっていないかを最初に見る
- [ ] Mac のブラウザ → Pi のブリッジ（Tailscale）で通しで確認する
- [ ] アイコンを作る
- [ ] 必要なら「Remote Control のセッションとして開く」（スマホの Claude アプリで続ける）を追加
