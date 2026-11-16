# 版本与发布

## 规则（从 v1.3.2 起执行）

**GitHub tag = release 名 = 插件版本号**，三者同一个数字：

```
插件 1.3.2  ←→  tag v1.3.2  ←→  release v1.3.2  ←→  资产 dsh-remote-workspaces-1.3.2.tgz
```

发版只跑一条命令：

```bash
./scripts/release.sh 1.3.2 "设备列表排版修复"
```

它会依次做六件事，任一步失败就停下：

1. 把 `plugin/package.json` 的版本改成给定值
2. `scripts/sync-engine.sh` 同步包内引擎副本（与 `cli/` 保持一致）
3. `npm pack` 打出 tarball
4. 用官方校验器验证 `market/index.json`
5. 建 GitHub release 并挂上 tarball（说明里自动写好安装地址）
6. 更新索引指向当前提交 → 提交 → 打 tag → 推 main 和 tag

## 早期版本对照（历史，不再改动）

早期仓库 tag 与插件版本是两套数字，因为插件包从 1.0.0 重新起算过。对照如下：

| 仓库 tag | 插件版本 | 主要内容 |
|---|---|---|
| v1.0.0 / v1.0.1 | 1.0.0 / 1.0.1 | 首个开源版；修 `engines.dsh` 让预发布运行时也能装 |
| v1.3.0 | 1.1.2 | 流量按小时分桶 |
| v1.4.0 | 1.1.3 | 声明为组合包，插件管理器可接管 |
| v1.5.0 | 1.1.4 | 面板顶部显示版本与联系方式 |
| v1.6.0 | 1.1.5 | 顶部卡片排版 + 图标 |
| v1.7.0 | 1.1.6 | 工作区列表默认展开 |
| v1.8.0 | 1.2.0 | 一个本地端同时连多台远程端 |
| v1.9.0 | 1.2.1 | 自愈占用端口的旧引擎 |
| v1.10.0 | 1.2.2 | 设备列表分区（远程端 / 本地端） |
| v1.11.0 | 1.3.0 | 本地端登记为设备 + 列表重做 |
| v1.12.0 | 1.3.1 | 补齐样式键，修掉裸文本渲染 |

## 版本语义

```
0.x  接口/落盘格式还在动
1.x  设置页、CLI 命令面、索引条目已冻结；改动都是修 bug 与打磨
```

## 发版前自检

```bash
node scripts/self-test.mjs            # 15 项离线自检（CI 也跑这个）
node scripts/preview-panel.mjs        # 面板排版预览（需要 react）
node scripts/validate-market-index.mjs
```

`release.sh` 要求工作树干净；被打出的 `plugin/*.tgz` 与 `dist/` 已在 `.gitignore` 里。
