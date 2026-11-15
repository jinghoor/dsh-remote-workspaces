#!/usr/bin/env bash
# 插件内自带一份隧道引擎（npm 包不能引用包外文件），用它把 cli/ 的版本同步进来。
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cp "$REPO/cli/dsh-relay.mjs" "$REPO/plugin/lib/dsh-relay.mjs"
echo "==> 已同步 cli/dsh-relay.mjs → plugin/lib/dsh-relay.mjs"
diff -q "$REPO/cli/dsh-relay.mjs" "$REPO/plugin/lib/dsh-relay.mjs" >/dev/null && echo "一致"
