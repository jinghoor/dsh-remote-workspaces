# DSH 远程工作区

把另一台电脑上的 DSH 工作区与会话并进本机侧边栏：带 🌐 标记，会话在那台执行，记录与队列在这边同步。
自带账号体系、主动外连隧道和图形设置页。

MIT License · 插件包 `dsh-remote-workspaces` · DSH ≥ 0.2.1-0

**装完就能用**：插件内置了公共中转地址，注册账号 → 两台设备登录同一账号 → 连上。
自建中转见 [docs/service.md](docs/service.md)。

远端只需要跑 DSH 本身 + 一个几十 KB 的 agent：**不用装插件、不用开端口**，两端都主动外连中转。

```
本机浏览器（官方侧边栏，未改动）
   │ /api/session/list · session/follow · workspace/follow · session/control · $events
   ▼
本机 Host ← dsh-remote-workspaces 插件（把远端并进这些方法的返回值）
   │ HTTP + WebSocket，经 TLS 打到中转
   ▼
<relay>:19090  relay（两端都主动外连，只转发字节）
   ▲
   │ 远端 agent 主动外连
   远端 DSH（桌面版或 CLI 实例）
```

## 组成部分

| 目录 | 是什么 |
|---|---|
| `plugin/` | **当前插件**（就是能用的那份）：Host 侧代理 + 设置页面板 |
| `relay/` | 中转服务端（跑在服务器上，systemd 常驻） |
| `cli/` | 两端共用 CLI：`agent`（远端）与 `client`（本机） |
| `scripts/` | `verify.mjs`（直连远端）、`verify-host.mjs`（打本机 Host 真实 HTTP 面） |
| `install.sh` | 把插件装进某个 profile（幂等，不重启） |
| `plugin/` | **当前插件**（可发布的 npm 包）：Host 侧代理 + 设置页 + 隧道管理 |
| `legacy/v1-panel/` | 历史版本：早期的「远程面板」独立插件，已被 `plugin/` 取代 |
| `notes/protocol.md` | 逆出来的 DSH HTTP/RPC 协议（0.2.1 实测） |
| `.work/review/notes.md` | 逐轮踩坑与验证记录（含每轮实测数据） |

## 为什么不是官方功能

DSH 0.2.2-rc.1 没有这个能力：客户端没有 remote host 界面，CLI 没有连远端 host 的参数，
`dsh-api-remotes` 只是 BFF 层（不含传输），`experimental-liveshare` 是**反方向**
（把本机会话推给外部查看者，且 Relay 服务端要自建）。所以整套是自己写的。

## 安装方式只能选一种

DSH 有两种装法，**不要混用**，否则会出现"管理器说装好了、运行的是另一份"：

| 方式 | 适用 | 说明 |
|---|---|---|
| 插件管理器（推荐） | 所有人 | 设置 → 插件 → 添加插件，粘贴 release 地址。升级也在管理器里 |
| `install.sh` | 只给开发者/离线环境 | 直接拷到 profile 的 `plugins/`。如果该 profile 已被管理器接管，脚本会拒绝执行 |

早期用 `launchctl` 起过 CLI 客户端的机器，要先停掉那条 LaunchAgent，否则它一直占着本地端口：

```bash
launchctl unload ~/Library/LaunchAgents/dev.dsh.relay.client.plist
mv ~/Library/LaunchAgents/dev.dsh.relay.client.plist ~/Library/LaunchAgents/dev.dsh.relay.client.plist.disabled
```

## 安装

### 1. 服务器（中转）

```bash
scp relay/relay.mjs relay/install-relay.sh root@<服务器>:/root/
ssh root@<服务器> 'cd /root && chmod +x install-relay.sh && ./install-relay.sh 19090 <服务器IP>'
```

安装脚本会生成自签证书、写入 `AGENT_SECRET`、装 systemd 单元并放行端口，
最后打印证书指纹和 agent/client 的启动命令。

### 2. 远端（跑 DSH 的那台）

Windows 的完整步骤见 [docs/windows.md](docs/windows.md)（含任务计划自启与插件安装两种方式）。
最短路径是只装引擎：

```powershell
curl.exe -k -o "$env:USERPROFILE\.dsh-relay\dsh-relay.mjs" https://<服务器>:19090/dsh-relay.mjs
node "$env:USERPROFILE\.dsh-relay\dsh-relay.mjs" login --relay <服务器>:19090 --user <账号>
node "$env:USERPROFILE\.dsh-relay\dsh-relay.mjs" setup --role agent --device desk --local auto
node "$env:USERPROFILE\.dsh-relay\dsh-relay.mjs" start
```

`--local auto` 会自动跟随 DSH 桌面版的端口（它每次启动都换端口）。

或手动指定端口：

```bash
curl -k -o dsh-relay.mjs https://<服务器>:19090/dsh-relay.mjs
node dsh-relay.mjs agent --relay <服务器>:19090 \
  --secret <AGENT_SECRET> --device desk \
  --local 127.0.0.1:<远端 DSH 端口> --fingerprint <指纹>
```

远端 DSH 本身（桌面版直接开即可；用 CLI 时要带 `--trusted-host`，见
[relay/README.md](relay/README.md)）。

### 3. 安装插件（最终用户只需要这一步）

DSH → **设置 → 插件 → 添加插件**，粘贴这个地址，点安装，然后重启 DSH：

```
https://github.com/jinghoor/dsh-remote-workspaces/releases/download/v1.10.0/dsh-remote-workspaces-1.2.2.tgz
```

> 这个框接受的是**安装包地址**（tarball / git 仓库 / npm 包名），不是市场索引。
> 装完重启 DSH，设置里会出现「DSH远程客户端」。

如果你的 DSH 启用了插件市场，也可以添加索引源：

```
https://raw.githubusercontent.com/jinghoor/dsh-remote-workspaces/main/market/index.json
```

发布新版本见 [docs/publishing.md](docs/publishing.md)。

### 4. 账号模式（推荐，多人各自隔离）

```bash
# 两端各自注册/登录同一个账号
node dsh-relay.mjs register --relay <服务器>:19090 --user alice
# 登录后设置这台机器的角色
node dsh-relay.mjs setup --role agent  --device desk --local 127.0.0.1:52893   # 远端
node dsh-relay.mjs setup --role client --device desk --listen 127.0.0.1:52900  # 本机
node dsh-relay.mjs start
```

不同账号之间互相看不见：设备名绑定账号，别人的 client 连你的设备会被 relay 拒绝。
详见 [relay/README.md](relay/README.md#账号多用户--数据隔离)。

### 5. 共享密钥模式（单人）

```bash
./cli/install.sh client --device desk --listen 127.0.0.1:52900 \
  --secret <AGENT_SECRET> --fingerprint <指纹> --daemon

./install.sh            # 把插件装进 profile（默认 desktop）
# 重启 DSH
```

然后打开「设置 → 账号与隧道」：注册/登录账号，选这台机器是远端端还是本地端，点启动。
隧道起来后会自动写好主机凭据，侧边栏直接出现远端工作区。

也可以用 CLI 做同样的事（两者共享 `~/.dsh-relay/config.json`）：

```bash
node cli/dsh-relay.mjs login  --relay <服务器>:19090 --user alice
node cli/dsh-relay.mjs setup  --role client --device desk --listen 127.0.0.1:52900
node cli/dsh-relay.mjs start
```

## 凭据的两种模式

| 模式 | 适用 | 说明 |
|---|---|---|
| token | 远端跑 CLI `dsh web` | 启动时打印，每次启动会变 |
| cookie | 远端跑桌面版（不打印 token） | 从 Electron 的 cookie 库明文取出，与 authority 绑定 |

cookie 模式要额外给 `authority`（远端 Host 自己的 `127.0.0.1:<端口>`），插件据此发 Host 头，
所以**本机监听端口不必与远端一致**。

自动同步：远端 agent 加 `--endpoint-file`，每 5 秒读 `{authority, cookie}` 并推给本机，
本机 client 写进插件配置，插件监听到文件变化自动重载——远端换端口/cookie 不再需要人工搬运。

## 已验证

```
verify.mjs      15/15   直连远端：列表 / 工作区 / 建会话 / 跟进流 / 文本 / 事件 /
                                排队 / 停止 / 内联图片 / 文件上传+引用 / 图片回读
verify-host.mjs  7/7    打本机 Host 真实 HTTP 面（桌面版渲染层走的就是这条路）
```

另有：双向消息同步（远端发→本地收 65 帧）、运行状态事件（`api-session/status` 到本地）、
设置页保存不丢凭据、工作区勾选即时生效、端点文件改端口后自动跟随。

## 已知限制

- 远端会话下的**文件树 / 终端 / diff / 目录选择器**读的是本机 FS，要一致得连
  `terminal` / `fs` / `workspace-files` 一起代理，是另一个量级的工程。
- 桌面版里**粘贴/拖入附件**这一步（浏览器把 File 交给上传 API）尚未在应用内实测通过；
  API 侧已全绿（见上），若失败请在[notes](.work/review/notes.md)里找对应现象。
- 远端 token/cookie 随远端重启轮换；接上 `--endpoint-file` 才免人工。
- 排序只在本次运行内有效。

## 排障

先看插件自检（任意 `dsh-auth-*` cookie 即可）：

```bash
curl -H 'cookie: dsh-auth-x=1' http://127.0.0.1:<本机端口>/remote-workspaces/status
```

`plugin/README.md` 里有完整对照表（401 / 工作区为 0 / writer-held / agent preset 缺失 /
改 `remote.mjs` 不生效等）。
