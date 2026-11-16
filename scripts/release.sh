#!/usr/bin/env bash
# 一条命令发版：bump 插件版本 → 同步引擎 → 打包 → 提交 → 更新索引 → 打 tag → 推送 → 建 release。
#
#   ./scripts/release.sh 1.13.0 "一句话说明这版改了什么"
#
# 规则：GitHub tag = release 名 = 插件版本号，三者同名。历史 tag v1.0.0…v1.12.0 已被占用，
# 新版本必须高于它们（对照表见 docs/releases.md）。
set -euo pipefail

VERSION="${1:?用法: release.sh <x.y.z> [说明]}"
NOTE="${2:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号必须是 x.y.z" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "工作树有未提交改动，先提交再发版" >&2; exit 1; }

# tag 必须可用：撞上历史 tag 会让 release 挂到旧提交上
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  echo "tag v$VERSION 已存在于本地，换一个版本号" >&2
  exit 1
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/v$VERSION" 2>/dev/null)" ]; then
  echo "tag v$VERSION 已存在于远端（历史版本），换一个版本号" >&2
  exit 1
fi

echo "==> 1/7 更新 plugin/package.json → $VERSION"
python3 - "$VERSION" <<'PY'
import json, pathlib, sys
path = pathlib.Path('plugin/package.json')
data = json.loads(path.read_text())
data['version'] = sys.argv[1]
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
print('   ', data['name'], data['version'])
PY

echo "==> 2/7 同步包内引擎副本"
./scripts/sync-engine.sh >/dev/null
echo "    完成"

echo "==> 3/7 打包"
(cd plugin && npm pack >/dev/null)
TARBALL="plugin/jinghoor-dsh-remote-workspaces-${VERSION}.tgz"
[ -f "$TARBALL" ] || { echo "打包失败" >&2; exit 1; }
ls -l "$TARBALL" | awk '{print "   ", $NF, $5"字节"}'

echo "==> 4/7 提交版本变更"
git add -A
git -c user.name="jinghoor" -c user.email="jinghooor@gmail.com" commit -q -m "release: v$VERSION ${NOTE}"
SHA="$(git rev-parse HEAD)"
echo "    提交 $SHA"

echo "==> 5/7 市场索引指向该提交"
python3 - "$VERSION" "$SHA" <<'PY'
import json, pathlib, re, sys, time
version, sha = sys.argv[1], sys.argv[2]
market = pathlib.Path('market/index.json')
data = json.loads(market.read_text())
entry = data['plugins'][0]['versions'][0]
entry.update({
  'version': version,
  'publishTimestamp': int(time.time()),
  'source': {
    'type': 'git',
    'url': 'https://github.com/jinghoor/dsh-remote-workspaces',
    'commit': sha,
    'path': 'plugin',
  },
  'engines': {'dsh': '>=0.2.1-0'},
})
market.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

readme = pathlib.Path('README.md')
text = readme.read_text()
text = re.sub(
  r'releases/download/v[0-9.]+/[a-z-]*dsh-remote-workspaces-[0-9.]+\.tgz',
  f'releases/download/v{version}/jinghoor-dsh-remote-workspaces-{version}.tgz',
  text,
)
readme.write_text(text)
print('    索引与 README 指向 v' + version)
PY
node scripts/validate-market-index.mjs | head -2

echo "==> 6/7 提交索引 + 打 tag + 推送"
git add -A
git -c user.name="jinghoor" -c user.email="jinghooor@gmail.com" commit -q -m "chore(market): $VERSION"
git tag -a "v$VERSION" -m "v$VERSION ${NOTE}"
git push -q origin main
git push -q origin "v$VERSION"
echo "    已推送 main 与 v$VERSION"

echo "==> 7/7 建 GitHub release"
gh release create "v$VERSION" "$TARBALL" \
  --title "v$VERSION" \
  --notes "安装（插件管理器 →「添加插件」粘贴）：

    https://github.com/jinghoor/dsh-remote-workspaces/releases/download/v$VERSION/jinghoor-dsh-remote-workspaces-$VERSION.tgz

${NOTE}"

echo
echo "完成：v$VERSION"
echo "  资产: $TARBALL"
echo "  索引: 指向 ${SHA}（plugin/ 与 tag 内容一致）"
echo "  CI  : gh run list --limit 1"
