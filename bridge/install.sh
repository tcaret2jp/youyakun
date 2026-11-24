#!/usr/bin/env bash
# youyakun ブリッジを systemd のユーザーサービスとして入れる（sudo 不要）
#   ./install.sh                 … 127.0.0.1 だけで待ち受け（同じマシンのブラウザから使う）
#   ./install.sh --tailscale     … 127.0.0.1 と Tailscale の IP で待ち受け（Mac などから使う）
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"
CONF_DIR="$HOME/.config/youyakun"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/youyakun-bridge.service"

hosts='["127.0.0.1"]'
if [[ "${1:-}" == "--tailscale" ]]; then
  ip="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  if [[ -z "$ip" ]]; then echo "Tailscale の IP が取れません" >&2; exit 1; fi
  hosts="[\"127.0.0.1\", \"$ip\"]"
fi

mkdir -p "$CONF_DIR" "$UNIT_DIR"
# 設定ファイルがなければ作る（トークンもここで発行される）
python3 "$HERE/youyakun_bridge.py" --print-token >/dev/null
# 待ち受けアドレスだけ書き換える（トークンなど他の値は残す）
python3 - "$CONF_DIR/config.json" "$hosts" <<'EOF'
import json, sys
p, hosts = sys.argv[1], json.loads(sys.argv[2])
c = json.load(open(p, encoding="utf-8"))
c["hosts"] = hosts
json.dump(c, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
EOF

if [[ -e "$UNIT" ]]; then echo "既存の $UNIT を書き換えます"; fi
cat > "$UNIT" <<EOF
[Unit]
Description=youyakun bridge (YouTube 拡張から Claude Code を呼ぶ)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 $HERE/youyakun_bridge.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now youyakun-bridge.service
systemctl --user restart youyakun-bridge.service
sleep 1
systemctl --user --no-pager --lines=5 status youyakun-bridge.service || true
echo
echo "待ち受け: $hosts  ポート: $(python3 -c "import json;print(json.load(open('$CONF_DIR/config.json'))['port'])")"
echo "トークン（拡張の設定画面に貼る）:"
python3 "$HERE/youyakun_bridge.py" --print-token
