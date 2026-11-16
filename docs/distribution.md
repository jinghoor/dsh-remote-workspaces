# 让别人找到并安装它

这不是 DSH 官方插件，是第三方开发、你自建中转的插件。所以"能被搜到"取决于三个入口：
**npm**、**GitHub**、**社区转发**。按投入产出排序：

## 1. 发到 npm（最大的一步，必须你来）

插件管理器那个「添加插件」输入框接受**裸包名**。一旦上了 npm，用户只要输入：

```
dsh-remote-workspaces
```

不用记 URL、不用点 release 页面，还能拿到 `latest` 自动更新。npm 的搜索也会命中
`keywords` 里的 `dsh-plugin`、`deepseek-harness`。

```bash
npm login                 # 用你的 npm 账号
cd plugin && npm publish  # 包名 dsh-remote-workspaces，publishConfig.access=public
```

发布后验证：

```bash
npm view dsh-remote-workspaces version dist.tarball keywords
```

发完告诉我，我把 README、市场索引、release 说明里的安装方式全部切成包名。

## 2. GitHub 仓库的可见性（已配好）

| 项 | 现状 |
|---|---|
| description | 一句话说清"另一台电脑的 DSH 工作区并进侧边栏 + 内置中转" |
| topics | `dsh` `deepseek-harness` `dsh-plugin` `remote-control` `remote-workspaces` `tunnel` `relay` `multi-device` `nat-traversal` `self-hosted` |
| README 首屏 | 截图 + 三步安装 + FAQ（新用户 10 秒能判断是不是他要的） |
| license | MIT |
| CI | 每次 push 跑 15 项离线自检，绿色徽章能建立信任 |

还可以补的（需要你决定）：

- **Social preview 图**：仓库 Settings → Social preview 上传 1280×640 图，转发到聊天工具时是这张图
- **设置 homepage**：如果有落地页，`gh repo edit --homepage <url>`

## 3. 社区转发（模板可直接用）

中文 DSH 用户主要在这几个地方：即刻、V2EX、少数派 Matrix、知乎、B 站、微信公众号、
以及各类 AI 工具群 / QQ 群。发帖请只发**一段话 + 两张图 + 一个链接**，不要长文。

### 一句话版（群里/朋友圈）

> 做了个 DSH 插件：能把另一台电脑的 DSH 工作区直接并进本机侧边栏，带 🌐 标记，
> 点进去就像本地会话一样用，但执行在那台机器上。内置公共中转，两台设备登录同一
> 账号就能连，不用开端口、不用公网 IP。
> 装法：设置 → 插件 → 添加插件，粘贴 release 地址（见 README）。
> 反馈群：587118291

### 稍长版（V2EX / 即刻 / 知乎想法）

> **给 DSH 加了个「远程工作区」**
>
> 场景：主力机在跑长任务，想在笔记本上接着看/接着发消息。
>
> 做法不是投屏也不是 SSH，而是把远端 DSH 的工作区并进本机侧边栏——名字后面带 🌐，
> 里面的会话、消息、队列、运行状态都跟本地一致，但实际执行在远端那台机器上。
>
> 技术上有意思的点：官方没有这个能力，所以是 Host 层融合（把远端并进 session/list、
> workspace/follow、session/control 这些方法的返回值），运输层是自己写的中转——两端都
> 主动外连，所以两边都不需要公网 IP 或端口映射。
>
> 装法：DSH 设置 → 插件 → 添加插件，粘贴 release 包地址；两台设备登录同一账号即可。
> 代码（MIT）：https://github.com/jinghoor/dsh-remote-workspaces
> 有问题来 QQ 群 587118291。

### 发帖配图

- `docs/screenshots/sidebar.png` —— 侧边栏里带 🌐 的工作区（最能说明问题）
- `docs/screenshots/panel.png` —— 设置面板

## 4. 提交到官方插件市场（可选，需要对方接受）

DSH 的插件市场读 format 1 索引，本仓库自带一份（`market/index.json`，已通过官方校验器）。
如果官方市场接受第三方索引源，用户只要添加一次：

```
https://raw.githubusercontent.com/jinghoor/dsh-remote-workspaces/main/market/index.json
```

再往里提交条目需要对方仓库的写入权限，我们只能提 PR / issue。

## 5. 优先级建议

```
第 1 周：npm 发布（让"输入包名即可装"成立）+ 群里发 3 次
第 2 周：一篇稍长的帖子（V2EX / 即刻），带截图
之后  ：看日志里的注册量，再决定要不要做落地页 / 视频
```

中转侧的注册量可以直接看：

```bash
journalctl -u dsh-relay | grep -c "account registered"
dsh-relay stats --secret <relay密钥>
```

## 6. 一句提醒

公开服务 = 你要为别人的流量付费，也要处理滥用。上线前把
[docs/service.md](service.md) 里的配额与吊销手段过一遍，别等出事再收紧。
