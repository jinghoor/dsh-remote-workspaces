#!/usr/bin/env bash
# 在服务器上安装 DSH 中转（Ubuntu/Debian，systemd）。
# 用法（在服务器上，root）：
#   ./install-relay.sh [端口] [公网IP或域名]
set -euo pipefail

PORT="${1:-19090}"
PUBLIC_HOST="${2:-}"
DIR=/opt/dsh-relay
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null || { echo "需要 node (>=18)" >&2; exit 1; }
command -v openssl >/dev/null || { echo "需要 openssl" >&2; exit 1; }

mkdir -p "$DIR"
install -m 0644 "$HERE/relay.mjs" "$DIR/relay.mjs"
install -m 0644 "$HERE/dsh-relay.mjs" "$DIR/dsh-relay.mjs"

if [ ! -f "$DIR/secret" ]; then
  openssl rand -base64 32 | tr -d '\n' > "$DIR/secret"
  chmod 600 "$DIR/secret"
fi
SECRET="$(cat "$DIR/secret")"

if [ ! -f "$DIR/cert.pem" ] || [ ! -f "$DIR/key.pem" ]; then
  SAN="DNS:localhost,IP:127.0.0.1"
  if [ -n "$PUBLIC_HOST" ]; then SAN="$SAN,IP:$PUBLIC_HOST"; fi
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
    -subj "/CN=dsh-relay" -addext "subjectAltName=$SAN" >/dev/null 2>&1
  chmod 600 "$DIR/key.pem"
fi

cat > /etc/systemd/system/dsh-relay.service <<UNIT
[Unit]
Description=DSH relay (agent/client pairing)
After=network-online.target

[Service]
ExecStart=/usr/bin/node $DIR/relay.mjs --port $PORT --host 0.0.0.0 --cert $DIR/cert.pem --key $DIR/key.pem --secret $SECRET --cli $DIR/dsh-relay.mjs
Restart=always
RestartSec=3
User=root
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable dsh-relay >/dev/null 2>&1 || true
systemctl restart dsh-relay

if command -v ufw >/dev/null; then
  ufw allow "$PORT"/tcp >/dev/null 2>&1 || true
fi

sleep 1
FINGERPRINT="$(openssl x509 -in "$DIR/cert.pem" -noout -fingerprint -sha256 | sed 's/^.*=//')"
HOST="$PUBLIC_HOST"
[ -n "$HOST" ] || HOST="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<服务器IP>')"

systemctl --no-pager --lines=0 status dsh-relay || true
echo
echo "==================== 中转已就绪 ===================="
echo "地址       : $HOST:$PORT"
echo "证书指纹   : $FINGERPRINT"
echo "AGENT_SECRET=$SECRET"
echo
echo "远端机器安装（一条命令）："
echo "  curl -k -o dsh-relay.mjs https://$HOST:$PORT/dsh-relay.mjs"
echo
echo "远端启动："
echo "  node dsh-relay.mjs agent --relay $HOST:$PORT --secret $SECRET \\"
echo "    --device desk --local 127.0.0.1:52893 --fingerprint $FINGERPRINT"
echo
echo "本机启动："
echo "  node dsh-relay.mjs client --relay $HOST:$PORT \\"
echo "    --device desk --listen 127.0.0.1:52900 --fingerprint $FINGERPRINT"
echo "===================================================="
