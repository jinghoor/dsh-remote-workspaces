#!/usr/bin/env bash
# 安装并启用 remote-sessions 插件。
#
# 用法: ./enable.sh <本机能访问到的地址> <token> [显示名] [profile名]
# 例:   ./enable.sh 'http://127.0.0.1:52900' 'AbCdEf...' 笔记本
#       ./enable.sh 'http://100.64.1.5:52893' 'AbCdEf...' 公司机器 web
#
# 地址填「本机能摸到的」，不是对方电脑的真实地址：
#   SSH 隧道 -> http://127.0.0.1:52900
#   Tailscale -> http://100.x.x.x:52893
set -euo pipefail

BASE_URL="${1:?用法: enable.sh <地址> <token> [显示名] [profile名]}"
TOKEN="${2:?缺 token：远端 dsh 启动时打印的 ?token=...}"
LABEL="${3:-远端}"
PROFILE_NAME="${4:-desktop}"

PLUGIN_NAME="dsh-remote-sessions"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="$HOME/.dsh/profiles/$PROFILE_NAME"
TARGET="$PROFILE/plugins/$PLUGIN_NAME"
PATCH="$PROFILE/cordis.patch.yml"

if [ ! -d "$PROFILE" ]; then
  echo "profile 不存在: $PROFILE" >&2
  echo "可用 profile:" >&2
  ls -1 "$HOME/.dsh/profiles" 2>/dev/null | grep -v node_modules >&2 || true
  exit 1
fi

echo "==> profile: $PROFILE"

# 1. 放插件本体 + 建包名软链（loader 按包名解析）
if [ "$SRC" != "$TARGET" ]; then
  mkdir -p "$PROFILE/plugins" "$PROFILE/node_modules"
  rm -rf "$TARGET"
  cp -R "$SRC" "$TARGET"
  echo "==> 已复制插件到 $TARGET"
else
  mkdir -p "$PROFILE/node_modules"
  echo "==> 插件已在目标位置"
fi
ln -sfn "$TARGET" "$PROFILE/node_modules/$PLUGIN_NAME"
echo "==> 已链接 $PROFILE/node_modules/$PLUGIN_NAME"

# 2. 写配置（已有就跳过，不覆盖用户手改过的值）
if grep -q "id: $PLUGIN_NAME" "$PATCH" 2>/dev/null; then
  echo "==> patch 里已有 ${PLUGIN_NAME}，未改动"
  echo "    要改地址或 token，手动编辑 $PATCH"
else
  [ -f "$PATCH" ] || : > "$PATCH"
  BACKUP="$PATCH.bak-remote-sessions-$(date +%Y%m%d_%H%M%S)"
  cp "$PATCH" "$BACKUP"
  cat >> "$PATCH" <<YAML

# 远程会话：把另一台电脑的 dsh Host 会话接进侧边栏。
# 远端重启后 token 会变，改这里的 token 再重载插件。
- insert:
    - id: $PLUGIN_NAME
      name: '$PLUGIN_NAME'
      config:
        hosts:
          - id: remote
            label: '$LABEL'
            baseUrl: '$BASE_URL'
            token: '$TOKEN'
YAML
  echo "==> 已写入 $PATCH"
  echo "    备份: $BACKUP"
fi

cat <<'NEXT'

==> 完成。让 dsh 重读 profile 后生效：
    - 重启 dsh（会中断当前对话）
    - 或 profile 的 HMR 行开启时，改 profile 会被重新读取
    侧边栏「插件 / 自动化任务」下面会出现「远程」。

NEXT
