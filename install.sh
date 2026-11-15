#!/usr/bin/env bash
# 安装/更新 dsh-remote-workspaces 插件到某个 profile。
#
# 用法: ./install.sh [profile名或路径]
#   ./install.sh            # 默认 desktop
#   ./install.sh web        # ~/.dsh/profiles/web
#
# 只做三件事：复制插件、建包名软链、在 cordis.patch.yml 里补插入声明。
# 不重启、不动已有配置；重复执行安全。
set -euo pipefail

PLUGIN_NAME="dsh-remote-workspaces"
TARGET_ARG="${1:-desktop}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/plugin"

if [ -d "$TARGET_ARG" ]; then
  PROFILE="$(cd "$TARGET_ARG" && pwd)"
else
  PROFILE="$HOME/.dsh/profiles/$TARGET_ARG"
fi

[ -d "$PROFILE" ] || { echo "profile 不存在: $PROFILE" >&2; ls -1 "$HOME/.dsh/profiles" 2>/dev/null >&2; exit 1; }
[ -f "$SRC/lib/index.js" ] || { echo "找不到插件源码: $SRC" >&2; exit 1; }

echo "==> profile: $PROFILE"
echo "==> 源码   : $SRC"

# 1. 复制插件本体 + 包名软链（loader 按包名解析）
mkdir -p "$PROFILE/plugins" "$PROFILE/node_modules"
rm -rf "$PROFILE/plugins/$PLUGIN_NAME"
cp -R "$SRC" "$PROFILE/plugins/$PLUGIN_NAME"
ln -sfn "$PROFILE/plugins/$PLUGIN_NAME" "$PROFILE/node_modules/$PLUGIN_NAME"
echo "==> 已安装到 $PROFILE/plugins/$PLUGIN_NAME"

# 2. patch 里补插入声明（已有就跳过）
PATCH="$PROFILE/cordis.patch.yml"
if grep -q "id: $PLUGIN_NAME" "$PATCH" 2>/dev/null; then
  echo "==> patch 已包含 ${PLUGIN_NAME}，未改动"
else
  [ -f "$PATCH" ] || echo '[]' > "$PATCH"
  cp "$PATCH" "$PATCH.bak-remote-workspaces-$(date +%Y%m%d_%H%M%S)"
  # 空数组占位要先去掉，否则 YAML 里同时出现 [] 和列表项
  if [ "$(tr -d '[:space:]' < "$PATCH")" = "[]" ]; then
    printf '' > "$PATCH"
  fi
  cat >> "$PATCH" <<YAML

# 远端工作区：把另一台电脑的 DSH 工作区并进左侧同一棵树。
# 主机与勾选在「设置 → 远程主机」里配置，保存在同目录的 remote-workspaces.json。
- insert:
    - id: $PLUGIN_NAME
      name: '$PLUGIN_NAME'
YAML
  echo "==> 已写入 $PATCH"
fi

# 3. 配置文件占位（真正的值由设置页写入）
CFG="$PROFILE/remote-workspaces.json"
if [ ! -f "$CFG" ]; then
  printf '{\n  "hosts": [],\n  "include": {}\n}\n' > "$CFG"
  chmod 600 "$CFG"
  echo "==> 已创建 $CFG"
fi

cat <<'NEXT'

==> 完成。让插件生效需要重启 DSH：
    - 重启后打开「设置 → 远程主机」添加远端主机（地址 + 启动时打印的 token）
    - 添加后远端工作区会出现在左侧工作区树里，名字后面带 🌐
    - 勾选决定哪些工作区显示；顺序在左侧列表里直接拖
NEXT
