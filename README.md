# youyakun（ようやくん）

YouTube の字幕を一括コピーし、そのまま Claude Code に渡して要約・質問できるブラウザ拡張（Chrome / Brave / Chromium）。
「YouTube Summary with ChatGPT & Claude」に近い使い勝手を、自分の Claude Code（Raspberry Pi 上）で動かす。

## 現状（2026-11-24）
- v0.1 を実装。ブリッジ（Pi 側）は要約・続きの質問・途中停止まで動作確認済み
- Codex レビューの指摘（停止時に Claude が残る、接続の居座り、初回の二重送信、失敗したセッション ID の保存など）は反映済み
- ブリッジを Pi に常駐済み（2026-11-24、`install.sh --tailscale`。127.0.0.1 と Pi の Tailscale IP の 8765 番）
- 接続先（ブリッジ）を複数登録して切り替えられるようにした（設定画面と YouTube のパネルの両方から）
- 作業フォルダを選べるようにした（v0.2）。アイコンを追加
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

字幕の取り方（v0.4〜）：
1. **get_panel（主）**：YouTube 公式の文字起こしパネルと同じ API を、パネルを開かずに認証なしで呼ぶ。プレイヤーの字幕設定に一切触れない。ただし言語は YouTube が 1 つ選ぶ（手動字幕が優先）。日本語の動画ならたいていこれで日本語が取れる（2026-11-24 の確認で 8 本中 7 本）
2. **プレイヤー経由（get_panel が欲しい言語でなかったとき）**：`page.js` がプレイヤーの字幕ファイル URL（確認用の値 `pot` 付き）を拾い、言語を差し替えて読む。字幕がオフなら、画面に出さずに一瞬オンにしてすぐ戻す。YouTube の字幕設定（`yt-player-caption-persistence` / `yt-player-caption-sticky-language`）は保存して元に戻す
   - 開いた直後のプレイヤーは pot なしで一度読み込んで空になるので、字幕を付け直して読み込み直させる
3. get_transcript・pot なしの timedtext：2026-11 時点ではどちらも失敗（400 / 空）。仕様が戻ったときのために残す
4. ページの「文字起こし」パネル：**自分では開かない**。すでに開いているときだけ読む
- 既定の字幕は日本語（手動 → 自動生成 → 先頭の順）

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

### 作業フォルダの切り替え
- パネルの「作業フォルダ」で、Claude Code を動かすフォルダを選べる（デスクトップアプリで SSH 先のフォルダを選ぶのと同じ考え方）。そのフォルダの `CLAUDE.md` が読み込まれる
- 一覧に出るのは「youyakun 専用（既定）」「00_cc」と、`01_Project` / `02_Area` / `03_Resource` の直下のフォルダ。フォルダを増やせばすぐ一覧に出る
- 一覧を変えたいときは `~/.config/youyakun/config.json` に `workdir_roots`（直下を一覧にするフォルダ）と `workdir_extra`（そのまま足すフォルダ）を書き、`systemctl --user restart youyakun-bridge`
- 会話中は、そのセッションのフォルダに固定される（セッションはフォルダごとに保存されるため）。変えたいときは「新しい会話にする」
- Claude には今も道具を渡していない（ファイルを読んだりコマンドを動かしたりはしない）。フォルダで変わるのは読み込まれる `CLAUDE.md` とセッションの保存先

### 接続先の切り替え
- 設定画面の「＋ 追加」で接続先（例:「Pi（Tailscale）」「この Mac」）を増やし、「この接続先を使う」で切り替える
- 接続先が 2 つ以上あると、YouTube のパネルの上部にも切り替えのメニューが出る
- 会話は「接続先 × 動画」ごとに保存される。セッションはブリッジのマシンにあるため、接続先を変えると、その接続先での会話に切り替わる
- 別のマシンを接続先にするときは、そのマシンにもこのリポジトリを置いて `bridge/install.sh` を実行する（Claude Code が入っていること）

## 次にやること
- [x] 実際の YouTube で字幕取得を確認する（2026-11-24、プレイヤー経由で日本語の自動生成 1009 行を時刻つきで取得）
  - Codex の指摘: 最近の YouTube は文字起こしパネルを `get_panel` で読む新しい形になっていることがあり、そのときは①が失敗する。②も PO Token が必要な動画では空になる。③（ページのパネル）が頼りなので、パネルの要素名が変わっていないかを最初に見る
- [x] Mac の Brave で字幕の自動読み込みを確認（2026-11-24、v0.4.1）
- [ ] Mac の Brave → Pi のブリッジで「Claude で要約」まで通しで確認する
- [x] アイコンを作る（Codex 作。`extension/icons/icon.svg` が原本）
- [ ] 必要なら「Remote Control のセッションとして開く」（スマホの Claude アプリで続ける）を追加
