#!/usr/bin/env bash
# DSH 中转客户端安装脚本（远端跑 agent，本机跑 client）
#
# 远端（有 DSH 的那台）：
#   ./install.sh agent  --device desk --local 127.0.0.1:52893
# 本机（看界面的这台）：
#   ./install.sh client --device desk --listen 127.0.0.1:52900
#
# 可选：--daemon 后台常驻（写 pid/日志），不加则前台运行，Ctrl-C 结束。
set -euo pipefail

ROLE="${1:-}"; shift || true
DEVICE="desk"; LOCAL="127.0.0.1:52893"; LISTEN="127.0.0.1:52900"; DAEMON=0
RELAY="${DSH_RELAY:-<relay>:19090}"
SECRET="${DSH_RELAY_SECRET:-}"
FINGERPRINT="${DSH_RELAY_FP:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --local) LOCAL="$2"; shift 2 ;;
    --listen) LISTEN="$2"; shift 2 ;;
    --relay) RELAY="$2"; shift 2 ;;
    --secret) SECRET="$2"; shift 2 ;;
    --fingerprint) FINGERPRINT="$2"; shift 2 ;;
    --daemon) DAEMON=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

[ "$ROLE" = "agent" ] || [ "$ROLE" = "client" ] || { echo "用法: install.sh <agent|client> [选项]" >&2; exit 1; }
[ -n "$SECRET" ] || { echo "缺少 --secret（中转安装时打印的 AGENT_SECRET）" >&2; exit 1; }
[ -n "$FINGERPRINT" ] || { echo "缺少 --fingerprint（中转安装时打印的证书指纹）" >&2; exit 1; }

command -v node >/dev/null || { echo "需要 node（DSH 本身也依赖它）" >&2; exit 1; }

BASE="$HOME/.dsh-relay"
mkdir -p "$BASE"
CLI="$BASE/dsh-relay.mjs"
if [ ! -f "$CLI" ]; then
  echo "==> 下载 CLI"
  curl -k -fsS -o "$CLI" "https://$RELAY/dsh-relay.mjs"
fi
echo "==> CLI: $CLI ($(wc -c < "$CLI" | tr -d ' ') 字节)"

LOG="$BASE/$ROLE.log"
PID="$BASE/$ROLE.pid"

if [ "$ROLE" = "agent" ]; then
  ARGS=(agent --relay "$RELAY" --secret "$SECRET" --device "$DEVICE" --local "$LOCAL" --fingerprint "$FINGERPRINT")
else
  ARGS=(client --relay "$RELAY" --device "$DEVICE" --listen "$LISTEN" --fingerprint "$FINGERPRINT")
fi

if [ "$DAEMON" = "1" ]; then
  if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then
    echo "==> 已在运行 (pid $(cat "$PID"))，先停止"
    kill "$(cat "$PID")" 2>/dev/null || true
    sleep 1
  fi
  nohup node "$CLI" "${ARGS[@]}" >> "$LOG" 2>&1 &
  echo $! > "$PID"
  sleep 2
  if kill -0 "$(cat "$PID")" 2>/dev/null; then
    echo "==> 后台运行中 (pid $(cat "$PID"))，日志: $LOG"
    tail -2 "$LOG" || true
  else
    echo "==> 启动失败，日志:" >&2; tail -5 "$LOG" >&2; exit 1
  fi
  cat <<TIP

==> 想开机自启：
  macOS  : 用 LaunchAgent（见 $BASE/README.txt）
  Linux  : systemctl --user + Restart=always
TIP
  cat > "$BASE/README.txt" <<TXT
手动启动：
  node $CLI ${ARGS[*]}

停止：
  kill \$(cat $PID)
TXT
else
  echo "==> 前台运行（Ctrl-C 结束）"
  exec node "$CLI" "${ARGS[@]}"
fi
