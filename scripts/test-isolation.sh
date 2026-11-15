#!/usr/bin/env bash
# 验证账号隔离：不同账号之间不能互连，只有同账号的设备能配对。
#
# 前提：账号 A 的 agent 在线并占用某设备名（默认 desk）。
# 用法：./scripts/test-isolation.sh <A的设备名> [A的本机隧道端口]
set -uo pipefail
RELAY="<relay>:19090"
FP="6D:66:C8:F8:E9:D7:46:DA:13:59:03:75:B8:CB:6B:F8:A3:72:C9:BF:D2:A0:3A:CA:06:E0:11:2A:FA:97:B9:16"
DEVICE_A="${1:-desk}"
PORT_A="${2:-52900}"
CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cli/dsh-relay.mjs"
TMPB=$(mktemp -d)
DEVICE_B="iso-b-$$"
PORT_B=52971
PW="iso-$(date +%s)-pw"

pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS  $1  ← $3"; pass=$((pass+1)); else echo "FAIL  $1  ← 期望 $2，实际 $3"; fail=$((fail+1)); fi
}
code() {
  local out
  out=$(curl -s -o /dev/null -m 4 -w '%{http_code}' -H "Host: 127.0.0.1:${AUTHORITY}" "http://127.0.0.1:$1/" 2>/dev/null)
  # curl prints 000 itself on a dead port; a bare `|| echo` would double it.
  echo "${out:-000}"
}

AUTHORITY="$(python3 -c "
import json,pathlib
d=json.loads((pathlib.Path.home()/'.dsh/profiles/desktop/remote-workspaces.json').read_text())
print(d['hosts'][0].get('authority',''))")"
echo "账号 A 的设备：$DEVICE_A ｜ 远端 authority：$AUTHORITY ｜ A 隧道端口：$PORT_A"
echo "A 的隧道基线：$(code $PORT_A)"

echo
echo "== 注册临时账号 B =="
HOME=$TMPB node "$CLI" register --relay "$RELAY" --user "iso$RANDOM" --password "$PW" --fingerprint "$FP" 2>&1 | tail -1
TOKEN_B=$(python3 -c "
import json,pathlib,glob
p=glob.glob('$TMPB/.dsh-relay/config.json')[0]
print(json.loads(pathlib.Path(p).read_text())['token'])")

echo
echo "== 1) B 的 client 连 A 的设备（应被拒）=="
HOME=$TMPB timeout 8 node "$CLI" client --relay "$RELAY" --device "$DEVICE_A" --listen "127.0.0.1:$PORT_B" --token "$TOKEN_B" --insecure >/tmp/iso-b-client.log 2>&1 &
sleep 6
check "B→A 设备连不通" "000" "$(code $PORT_B)"
kill %1 2>/dev/null; wait 2>/dev/null

echo
echo "== 2) B 的 agent 抢注 A 的设备名（应被拒，且不能顶掉 A）=="
HOME=$TMPB timeout 8 node "$CLI" agent --relay "$RELAY" --device "$DEVICE_A" --local "127.0.0.1:51430" --token "$TOKEN_B" --insecure >/tmp/iso-b-agent.log 2>&1 &
sleep 6
check "A 的隧道未被顶掉" "401" "$(code $PORT_A)"
kill %1 2>/dev/null; wait 2>/dev/null

echo
echo "== 3) B 用自己名字的设备（应成功，且只对 B 可见）=="
HOME=$TMPB node "$CLI" config --token "$TOKEN_B" --relay "$RELAY" --device "$DEVICE_B" --local "127.0.0.1:51430" --role agent >/dev/null
HOME=$TMPB nohup node "$CLI" start >/tmp/iso-b-agent2.log 2>&1 &
AGENT_PID=$!
sleep 5
HOME=$TMPB node "$CLI" config --role client --device "$DEVICE_B" --listen "127.0.0.1:$PORT_B" >/dev/null
HOME=$TMPB nohup node "$CLI" start >/tmp/iso-b-client2.log 2>&1 &
CLIENT_PID=$!
sleep 6
check "B 自己的隧道可用" "401" "$(code $PORT_B)"
AUTHORITY_SAVE="$AUTHORITY"; AUTHORITY="127.0.0.1:51430"
check "B 的隧道指向其 agent 目标" "401" "$(code $PORT_B)"
AUTHORITY="$AUTHORITY_SAVE"

echo
echo "== 4) A 的账号去连 B 的设备（应被拒）=="
TOKEN_A="$(python3 -c "
import json,pathlib
print(json.loads((pathlib.Path.home()/'.dsh-relay/config.json').read_text()).get('token',''))")"
PORT_A2=52972
HOME=/tmp/iso-a node "$CLI" config --token "$TOKEN_A" --relay "$RELAY" --role client --device "$DEVICE_B" --listen "127.0.0.1:$PORT_A2" >/dev/null 2>&1
HOME=/tmp/iso-a timeout 8 node "$CLI" client --relay "$RELAY" --device "$DEVICE_B" --listen "127.0.0.1:$PORT_A2" --token "$TOKEN_A" --insecure >/tmp/iso-a.log 2>&1 &
sleep 6
AUTHORITY="127.0.0.1:51430"
check "A→B 设备连不通" "000" "$(code $PORT_A2)"
AUTHORITY="$AUTHORITY_SAVE"
kill %1 2>/dev/null; wait 2>/dev/null

echo
echo "== 5) 无凭据的旧客户端连账号设备（应被拒）=="
PORT_C=52973
nohup node "$CLI" client --relay "$RELAY" --device "$DEVICE_A" --listen "127.0.0.1:$PORT_C" --insecure >/tmp/iso-c.log 2>&1 &
sleep 5
check "无凭据→账号设备连不通" "000" "$(code $PORT_A)"
pkill -f "listen 127.0.0.1:$PORT_C" 2>/dev/null

kill $AGENT_PID $CLIENT_PID 2>/dev/null
pkill -f "$DEVICE_B" 2>/dev/null
rm -rf "$TMPB"
echo
echo "结果：$pass 通过 / $fail 失败"
echo "（临时账号与设备名 $DEVICE_B 需手工清理：release + user remove）"
[ "$fail" -eq 0 ]
