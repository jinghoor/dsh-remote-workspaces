# dsh-remote-workspaces

把另一台电脑上的 DSH 工作区和会话，**并进本机侧边栏那棵树**——不是另开一个面板。
远端工作区整组带 `🌐` 标记，点进去看历史、发消息、改名、分叉，全部转给远端执行。

## 怎么做到的

侧边栏的行只来自本机 Host 的 RPC，所以插件挂在 **Host 层**，不碰官方 UI：

```
本机浏览器（官方侧边栏，未改动）
   │ /api/session/list · /api/session/follow · /api/workspace/follow …
   ▼
本机 Host ← dsh-remote-workspaces（本插件，改写这几个方法的返回）
   │  HTTP /api/<endpoint>  +  WebSocket /api/remote.mux
   ▼
远端 DSH Host
```

- `session/list`：把远端会话行并进返回结果
- `workspace/follow`：把远端工作区注入基线（`workspaceId` 用 `remote:<hostId>:<id>`，
  标题加 `🌐`），后续 `order` 帧同样补上远端 id
- `session/page|events|projections|prompt|cancel|rename|fork|attachment|search|updateQueue|create`：
  按 sessionId 路由到对应远端
- `session/follow`：把远端的 mux 流转发成本机的一条流
- `workspace/insertBefore`：远端工作区的排序记在插件里，并立刻广播新顺序
- `fileUploads.uploadStream`：上传落到**会话所属的那台机器**，本机只中转字节、不落盘

## 文件与图片怎么走

| 类型 | 行为 |
|---|---|
| 图片（`{type:'image', data}`） | 内联在 prompt 里，跟着请求一起发给远端 |
| 文件（附件上传） | 先 POST 到远端的 `uploadFileBinary`，拿到**远端**的 receipt，再随 prompt 引用 |
| `@` 引用的工作区文件 | 由远端的 agent 在**远端磁盘**上解析——本机路径在远端通常不存在 |

实测：本机上传 23 字节到远端会话，字节出现在远端 `attachments/v1/files/.../probe.txt`，
本机 `attachments` 目录为空。

远端凭据只存在本机 Host 进程内存；浏览器只跟自己的 Host 通信。

## 安装

```bash
./install.sh            # 默认 ~/.dsh/profiles/desktop
./install.sh web        # 或指定 profile
```

会复制插件、建包名软链、在 `cordis.patch.yml` 里补一条插入声明（已有则跳过），
并创建 `remote-workspaces.json`。**生效需要重启 DSH。**

## 配置

首次安装后 `hosts` 为空。重启 DSH 打开「设置 → 远程主机」：

1. 添加主机：名称、地址（本机能访问到的）、token（远端启动时打印的）
2. 「测试连接」确认能同时拿到会话和工作区
3. 展开「工作区」，勾选哪些显示在侧边栏

配置写在 `<profile>/remote-workspaces.json`（0600）：

```json
{
  "hosts": [{ "id": "desk", "label": "台式机", "baseUrl": "http://127.0.0.1:52900", "token": "…" }],
  "include": { "desk": ["<远端 workspaceId>"] }
}
```

`include` 里某个主机**没有这个键** = 全部显示；**键存在但数组为空** = 全部隐藏。

## 网络

远端默认只绑 `127.0.0.1`，最省事的是 SSH 隧道：

```bash
ssh -N -L 52900:127.0.0.1:52893 用户名@对方地址
# 地址填 http://127.0.0.1:52900
```

## 限制

- 远端会话下的**文件树、终端、diff、目录选择器**读的是本机 FS，看到的是当前这台机器。
  要一致得连 `terminal` / `fs` / `workspace-files` 一起代理，那是另一个量级的工程。
- 远端 token 每次重启远端都会变，需要在设置页重填（本机 Host 会因此报鉴权失败）。
- 排序在本次运行内有效；重启后回到「本机工作区在前、远端在后，远端内部按配置顺序」。
- 同名工作区（两边都有 `Project-X`）是**两组**，靠 `🌐` 区分。

## 已验证

在隔离的双实例上实测过：

| 能力 | 结果 |
|---|---|
| 会话列表合并 | 本机 `/api/session/list` 返回远端行 |
| 工作区注入 | `workspace/follow` 基线含 `remote:b:<id>`，标题带 🌐 |
| 历史流代理 | `session/follow` 返回 snapshot，309 条记录 / cursor 1382 |
| 分页 / 投影 | `session/page` 241 条；`session/projections` asOfSeq=1382 |
| 远端建会话 | `session/create` 带远端 workspaceId，在远端建出并在本机列表可见 |
| 设置页路由 | config / workspaces / test 三个接口 + 无 cookie 401 |
| 勾选即时生效 | 取消勾选后流里 1 → 0 → 1，无需重启 |
| 客户端 bundle | boot 清单含 `rev`，`/plugins/??…&rev=…` 返回 200 |

未在本机目视确认过的：侧边栏树和设置面板的**渲染外观**（测试实例没有配置模型，
这个 web build 在没有模型时不渲染左侧树、也不出现设置入口）。装上后有模型的桌面端才会看到。

## 卸载

删除 `cordis.patch.yml` 里 `id: dsh-remote-workspaces` 的那条，重启即可；
插件目录和 `remote-workspaces.json` 可以留着。


## 直连桌面版（没有 token 的那台）

桌面版内嵌的 host 不打印 token，但它把浏览器 cookie **明文**存在 Chromium 的 cookie 库里。
插件支持直接用 cookie：

```json
{
  "hosts": [{
    "id": "desk",
    "label": "Windows 桌面版",
    "baseUrl": "http://127.0.0.1:52900",
    "cookie": "dsh-auth-...=v1...",
    "authority": "127.0.0.1:55455"
  }]
}
```

- `authority` 是**远端 Host 自己的** authority，插件用它做请求的 Host 头；
  本机监听端口（`baseUrl` 里的端口）可以随便，不需要和远端一致。
- cookie 与 authority 绑定；两者对不上时表现为 401，和「token 错」一模一样。

### 自动同步（推荐）

远端 agent 加 `--endpoint-file`，每 5 秒读一次：

```json
{ "authority": "127.0.0.1:55455", "cookie": "dsh-auth-...=v1..." }
```

变推送机制：agent → relay → 本机 client → 写入配置 → 插件监听到文件变化自动重载。
远端换端口、换 cookie 都不再需要人工搬运。

## 自检

两层脚本：

```bash
# 直连远端（不经过本机插件），验证远端能力
node scripts/verify.mjs --port <本机 Host 端口>

# 打本机 Host 的真实 HTTP 面（桌面版渲染层走的就是这条），验证插件代理
node scripts/verify-host.mjs --port <端口> --workspaceId <远端工作区 id>
```

`verify-host.mjs` 会自动从 Electron 的 cookie 库里取当前 Host 的凭据，
建的测试会话跑完会 `archiveSession` 归档掉。

## 自检（旧版说明）

```bash
node scripts/verify.mjs --port <本机 Host 端口>
```

会跑一遍：会话列表、工作区基线、建会话、跟进流、文本 prompt、事件流、
排队行、停止、内联图片、文件上传 + 文件 prompt，以及本机插件的注入状态。
只写一条一次性会话，跑完可以删。


## 设置页：账号与隧道

装好插件后，DSH 设置里会出现「账号与隧道」一栏，不用碰命令行：

| 区块 | 能做什么 |
|---|---|
| 中转与账号 | 填中转地址与证书指纹，注册 / 登录 / 退出；显示当前账号 |
| 这台机器的角色 | 选「远端端（跑 DSH）」或「本地端（我在这台查看）」，填设备名与地址，保存 / 启动 / 停止 |
| 运行日志 | 引擎最近 12 行输出（连接成功、cookie 更新、错误原因） |

勾上「DSH 启动时自动运行隧道」后，插件会在 Host 起来时按配置拉起隧道。

### 它和 CLI 是同一套东西

插件不实现隧道，只当外壳：它把设置写进 `~/.dsh-relay/config.json`，然后 spawn
插件自带的引擎 `lib/dsh-relay.mjs start`。CLI（`cli/dsh-relay.mjs`）读同一个文件，
两边随时可以混用：

```bash
dsh-relay config --role client      # 命令行改，设置页下一次轮询就会显示
dsh-relay setup --role agent        # 交互式
dsh-relay start                     # 不走插件也能跑
```

引擎和 `cli/dsh-relay.mjs` 是同一份代码（安装时复制），所以行为不会漂移。

### 一条龙效果

本地端选好角色、启动隧道后，客户端会把远端发来的 token/cookie **连同 authority**
写进 `remote-workspaces.json`，自动创建一条主机记录（`baseUrl` 指向隧道监听端口）。
也就是说：登录 → 选角色 → 启动，侧边栏就会出现远端工作区，不需要手工填任何东西。

## 排障

`GET /remote-workspaces/status`（带任意 `dsh-auth-*` cookie）会返回：

```json
{
  "patched": { "followShim": true, "listShim": false },
  "sessions": { "total": 311, "remote": 269 },
  "workspaces": { "total": 14, "remote": 11 },
  "lastError": null,
  "uploads": { "ok": 1, "failed": 0, "local": 0 }
}
```

对照表：

| 现象 | 原因 | 处理 |
|---|---|---|
| `sessions.remote` 为 0 | 远端不可达 | 查隧道：`curl -H 'Host: <authority>' -H "Cookie: …" http://127.0.0.1:52900/` 应返回 401/200 |
| 401 且 cookie 看起来没错 | `authority` 与 cookie 不匹配 | cookie 必须按**远端 Host 自己的** authority 签发 |
| `uploads.local` 增长 | 会话归属判成了本地 | 远端新建的会话需要一次 list 刷新，插件会自动做；反复出现说明远端不可达 |
| `lastError.code = session/writer-held` | 该会话在远端窗口里开着 | 在远端切走该会话 |
| `lastError` 含 `Unknown agent preset` | 该会话的 preset 在远端不存在 | 这条会话在远端本来也打不开，改用新会话 |
| 改了 `remote.mjs` / `config.mjs` 不生效 | ESM 模块缓存 | 这两类改动必须重启 DSH；`index.js` 可以热重载 |

版本差异：`session/attachment` 的 request 形状在 0.2.1（平铺）和 0.2.2（`attachment` 嵌套）不同。
插件原样转发，所以两端版本不同也能用；自己手工调试时才会踩到。
