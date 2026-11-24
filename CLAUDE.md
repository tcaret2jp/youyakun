# youyakun 固有のルール

- 拡張機能（`extension/`）は Manifest V3。ビルド工程なし、素の JavaScript で書く（ライブラリを入れない）
- ブリッジ（`bridge/youyakun_bridge.py`）は Python 標準ライブラリだけで書く
- ブリッジは Tailscale 越しに呼ばれうる。Claude には道具を渡さない（`--tools ""`）方針を崩すときは冬弥に確認する
- トークンは `chrome.storage.local` に置く（`sync` だと Google アカウントに同期されるため）
- ブリッジのテストは本番の設定を使わず、`YOUYAKUN_CONFIG_DIR=<スクラッチパッド>` と別ポートで起動する
- 現状と次にやることは `README.md` に書く
