# 发布到 DSH 插件市场

DSH 的插件市场读一份 **format 1 的 JSON 索引**（`@deepseek-ai/dsh-plugin-market-index` 里有官方校验器）。
索引里每个插件条目只需要两样东西：**可安装的来源**（npm 包或 git commit）和元数据。

所以发布 = 两件事：把包装发出去，把索引条目交上去。

## 0. 先改掉仓库占位符

`plugin/package.json` 与 `market/index.json` 里的 `OWNER` 要换成你的 GitHub 账号：

```bash
grep -rn OWNER plugin/package.json market/index.json
```

## 1. 发布 npm 包

```bash
cd plugin
npm whoami            # 没登录先 npm login
npm publish           # 包名 dsh-remote-client，publishConfig.access=public
```

发布后确认：

```bash
npm view dsh-remote-client version dist.tarball engines
```

包内应该只有 `lib/` 下的实现和 `README.md` / `LICENSE`（`files` 字段已限定）。
`lib/dsh-relay.mjs` 是隧道引擎的副本，发布前跑一次 `scripts/sync-engine.sh` 保证与 `cli/` 一致。

## 2. 校验市场索引

```bash
node scripts/validate-market-index.mjs
```

它直接调用官方校验器，输出类似：

```
PASS  format=1  title={"en":"DSH Remote Workspaces","zh":"DSH 远程工作区"}  plugins=1
      dsh-remote-client · versions=1.0.0 · category=remote
```

通过不了会打印具体路径，例如 `$.plugins[0].versions[0].version must be an exact SemVer version`。

## 3. 索引里需要按实际情况改的字段

`market/index.json` 里每个 `versions[]` 条目：

| 字段 | 取值 |
|---|---|
| `version` | 与 npm 上发布的一致，精确 SemVer |
| `publishTimestamp` | 发布时刻的 Unix **秒** |
| `source` | `{"type":"npm"}`；若要锁 git 提交则用 `{"type":"git","url":…,"commit":"<40 位小写 sha>"}` |
| `engines.dsh` | 兼容的 DSH 版本范围，当前 `>=0.2.1` |

新增版本时**追加**一个 `versions[]` 条目，不要改旧的。

## 4. 交付索引

两种方式，按对方要求选其一：

- **提交给官方索引**：把 `market/index.json` 里的 `plugins[]` 条目（或整份索引）提 PR / 发给市场维护方。
- **自建索引**：把 `market/index.json` 放到任意 HTTPS 地址（GitHub Pages、对象存储都行），
  在 DSH 插件市场里添加该地址即可。注意校验器要求：

  - 索引地址必须是绝对 URL；
  - `icon` 若是相对路径，只能解析到 **https** 或索引同源的地址；
  - `repository.url` 必须是至少两段路径的规范 URL，且不能是 tarball。

## 5. 版本节奏建议

```
0.x  →  还在改接口/落盘格式
1.0  →  设置页与 CLI 的命令面稳定，索引条目冻结
```

发布前的最小检查清单：

```bash
node scripts/validate-market-index.mjs      # 索引合法
./scripts/sync-engine.sh                    # 引擎副本一致
./scripts/package-plugin.sh                 # 能打出分发包
node --check plugin/lib/index.js            # 语法
node scripts/verify.mjs --port <本机端口>     # 15/15
```

## 附：为什么包里有 `lib/dsh-relay.mjs`

npm 包不能引用包外文件，而插件需要把隧道引擎作为子进程拉起来（GUI 与 CLI 必须是同一份实现）。
所以它被复制进包里，由 `scripts/sync-engine.sh` 保持同步，`scripts/package-plugin.sh` 会在不一致时告警。
