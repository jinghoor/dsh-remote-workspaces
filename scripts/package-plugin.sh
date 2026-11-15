#!/usr/bin/env bash
# 打插件分发包并推到 relay 的 /dist/。
#   ./scripts/package-plugin.sh                # 只打包
#   ./scripts/package-plugin.sh --publish      # 打包并上传到服务器
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/dist/dsh-remote-workspaces.tar.gz"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/dsh-remote-workspaces"
cp "$REPO/plugin/package.json" "$REPO/plugin/README.md" "$REPO/plugin/LICENSE" \
   "$REPO/plugin/cordis.patch.yml" "$STAGE/dsh-remote-workspaces/"
cp -R "$REPO/plugin/lib" "$STAGE/dsh-remote-workspaces/lib"
# 插件自带隧道引擎，保证 GUI 与 CLI 同一份实现
cp "$REPO/cli/dsh-relay.mjs" "$STAGE/dsh-remote-workspaces/lib/dsh-relay.mjs"
diff -q "$REPO/cli/dsh-relay.mjs" "$REPO/plugin/lib/dsh-relay.mjs" >/dev/null || {
  echo "warning: plugin/lib/dsh-relay.mjs 与 cli/ 不一致（先跑 scripts/sync-engine.sh）" >&2
}

mkdir -p "$REPO/dist"
# COPYFILE_DISABLE=1 关掉 macOS 的 ._* 侧车文件；--no-xattrs 去扩展属性
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$OUT" -C "$STAGE" dsh-remote-workspaces 2>/dev/null \
  || COPYFILE_DISABLE=1 tar -czf "$OUT" -C "$STAGE" dsh-remote-workspaces
echo "==> $OUT ($(wc -c < "$OUT" | tr -d ' ') 字节, $(tar -tzf "$OUT" | wc -l | tr -d ' ') 条目)"
tar -tzf "$OUT" | grep -c '/\._' && { echo "包内仍有 ._ 侧车文件" >&2; exit 1; } || true

if [ "${1:-}" = '--publish' ]; then
  : "${RELAY_HOST:=root@<relay>}"
  # Password auth when SSHPASS is exported, key auth otherwise.
  PREFIX=''
  if [ -n "${SSHPASS:-}" ] && command -v sshpass >/dev/null 2>&1; then PREFIX='sshpass -e'; fi
  # Set RELAY_SSH_OPTS for a non-default key or port.
  # shellcheck disable=SC2086
  $PREFIX ssh ${RELAY_SSH_OPTS:-} -o StrictHostKeyChecking=accept-new "$RELAY_HOST" 'mkdir -p /opt/dsh-relay/dist'
  # shellcheck disable=SC2086
  $PREFIX scp ${RELAY_SSH_OPTS:-} -o StrictHostKeyChecking=accept-new "$OUT" "$RELAY_HOST:/opt/dsh-relay/dist/dsh-remote-workspaces.tar.gz"
  echo "==> 已发布 https://<relay>:19090/dist/dsh-remote-workspaces.tar.gz"
fi
