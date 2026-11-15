#!/usr/bin/env bash
# 回滚到共享密钥模式（账号模式出问题时的退路）。
set -euo pipefail
DIR="$HOME/.dsh-relay"
python3 - "$DIR/config.json" <<'PY'
import json,sys,pathlib
path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text()) if path.exists() else {}
data.pop('token', None)
data.pop('username', None)
path.write_text(json.dumps(data, indent=2) + '\n')
print('已移除 token（回到共享密钥兼容路径）')
PY
launchctl unload "$HOME/Library/LaunchAgents/dev.dsh.relay.client.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/dev.dsh.relay.client.plist"
sleep 3
tail -3 "$DIR/client.launchd.log"
