#!/usr/bin/env bash
# 一条命令发版：bump 插件版本 → 打包 → 建 GitHub release → 更新市场索引 → 打 tag → 推送。
#
#   ./scripts/release.sh 1.3.2 "一句话说明这版改了什么"
#
# 规则：tag、release、插件版本三者必须同名（vX.Y.Z ↔ X.Y.Z）。历史版本对照见 docs/releases.md。
set -euo pipefail

VERSION="${1:?用法: release.sh <x.y.z> [说明]}"
NOTE="${2:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号必须是 x.y.z" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "工作树有未提交改动，先提交再发版" >&2; exit 1; }

echo "==> 1/6 更新 plugin/package.json → $VERSION"
python3 - "$VERSION" <<'PY'
import json, pathlib, sys
p = pathlib.Path('plugin/package.json')
d = json.loads(p.read_text())
d['version'] = sys.argv[1]
p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
print('   ', d['name'], d['version'])
PY

echo "==> 2/6 同步引擎副本"
./scripts/sync-engine.sh >/dev/null

echo "==> 3/6 打包"
(cd plugin && npm pack >/dev/null)
TARBALL="plugin/dsh-remote-workspaces-${VERSION}.tgz"
[ -f "$TARBALL" ] || { echo "打包失败" >&2; exit 1; }
ls -l "$TARBALL" | awk '{print "   ", $NF, $5"字节"}'

echo "==> 4/6 校验市场索引"
node scripts/validate-market-index.mjs | head -2

echo "==> 5/6 建 release v$VERSION"
gh release create "v$VERSION" "$TARBALL" \
  --title "v$VERSION" \
  --notes "$(printf '%s\n\n安装（插件管理器 →「添加插件」粘贴）：\n\n    https://github.com/jinghoor/dsh-remote-workspaces/releases/download/v%s/dsh-remote-workspaces-%s.tgz' "${NOTE:-v$VERSION}" "$VERSION" "$VERSION")"

echo "==> 6/6 提交 + 打 tag + 推送"
SHA="$(git rev-parse HEAD)"
python3 - "$VERSION" "$SHA" <<'PY'
import json, pathlib, sys, time
version, sha = sys.argv[1], sys.argv[2]
m = pathlib.Path('market/index.json')
data = json.loads(m.read_text())
v = data['plugins'][0]['versions'][0]
v.update({
  'version': version,
  'publishTimestamp': int(time.time()),
  'source': {'type': 'git', 'url': 'https://github.com/jinghoor/dsh-remote-workspaces', 'commit': sha, 'path': 'plugin'},
  'engines': {'dsh': '>=0.2.1-0'},
})
m.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

readme = pathlib.Path('README.md')
text = readme.read_text()
import re
text = re.sub(r'releases/download/v[0-9.]+/dsh-remote-workspaces-[0-9.]+\.tgz',
              f'releases/download/v{version}/dsh-remote-workspaces-{version}.tgz', text)
readme.write_text(text)
print('   索引与 README 已指向', version)
PY
git add -A
git -c user.name="jinghoor" -c user.email="jinghooor@gmail.com" commit -q -m "release: v$VERSION ${NOTE}"
git tag -a "v$VERSION" -m "v$VERSION ${NOTE}"
git push -q origin main
git push -q origin "v$VERSION"
echo
echo "完成：v$VERSION"
echo "  包装好: $TARBALL"
echo "  索引已更新到 $SHA（plugin/ 内容与 tag 一致）"
echo "  CI 会自动跑 15 项离线自检： gh run list --limit 1"
