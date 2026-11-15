# dsh-remote-sessions

把另一台电脑上的 DSH Host 会话接进本机 DSH 的侧边栏，作为一个「远程」面板：列出远端会话、
读它的完整历史、往它发消息（实际执行发生在远端机器）。

这是自研插件。DSH 0.2.2-rc.1 官方 195 个包 / 24 个 bundle 里没有任何等价物——
`experimental-liveshare` 是反方向（把本机会话推给外部查看者，且需要自建 Relay 服务端）。

## 结构

```
lib/index.js    Host 侧：token→cookie 换证、转发远端 /api/<endpoint>、注册 /remote-dsh/* 路由
lib/client.js   浏览器侧：侧边栏「远程」入口 + 主面板（列表 / 历史 / 发送）
```

数据流：

```
浏览器 (client.js)
   │  GET  /remote-dsh/sessions?host=<id>
   │  GET  /remote-dsh/history?host=&sessionId=
   │  POST /remote-dsh/rpc  {host, endpoint, args}
   ▼
本机 Host (lib/index.js)
   │  POST http://<远端>/api/<endpoint>   + cookie（首次由 token 换取后缓存）
   ▼
远端 DSH Host
```

远端凭据只存在本机 Host 进程内存里，不写盘，也不下发给浏览器。浏览器只跟自己的 Host 通信，
所以不存在跨站 cookie / CORS 问题。

## 安装

### 远端那台电脑

1. 监听一个能被本机访问到的地址（默认只绑 127.0.0.1）：

```bash
dsh --profile web --host 192.168.1.50 --port 52893
```

不方便开端口就走 SSH 隧道，远端保持默认：

```bash
# 本机执行
ssh -N -L 52900:127.0.0.1:52893 user@remote-host
# 之后 baseUrl 用 http://127.0.0.1:52900
```

2. 记下启动时打印的 `?token=...`。**这个 token 每次启动都会换**，远端重启后要把新 token
   填进下面的配置并重载本机插件。

### 本机

插件装进 profile，并让 loader 能解析到包名：

```bash
PROFILE=~/.dsh/profiles/desktop
mkdir -p "$PROFILE/plugins" "$PROFILE/node_modules"
cp -R "plugins/dsh-remote-sessions" "$PROFILE/plugins/"
ln -sfn "$PROFILE/plugins/dsh-remote-sessions" "$PROFILE/node_modules/dsh-remote-sessions"
```

在 `$PROFILE/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: remote-sessions
      name: 'dsh-remote-sessions'
      config:
        hosts:
          - id: laptop
            label: 笔记本
            baseUrl: 'http://192.168.1.50:52893'
            token: '<远端启动时打印的 token>'
        # requestTimeoutMs: 20000
```

改完要重新加载插件：profile 的 HMR 行开启时改 profile 会被重新读取，否则等下一次 `dsh` 启动。

## 行为

- 面板在侧边栏「插件 / 自动化任务」之后，图标是全球形。
- 列表显示远端会话标题、运行状态、更新时间、工作目录。多个 host 时顶部出现下拉。
- 点一行进入历史视图：用户输入、assistant 文本、工具调用各占一行；`reasoning` 块不显示。
- 底部输入框 `Cmd/Ctrl+Enter` 发送，走远端 `session/prompt`（`mode: 'queue'`）。
- 历史端点对 0.2.2 用 `session/events`，对 0.2.1 回退到 `session/page`，返回形状统一。

## 限制

- **发送路径未实测**：测试时远端与本机共享 `$DSH_HOME/sessions`，发一条会真的写进同一个会话日志，
  所以没有跑。代码路径与已实测的历史读取共用同一个转发函数。
- 只读最新一页历史（默认 120 条消息），没有向上翻页。
- 不做推送：远端会话有新输出时不会自动刷新，需要点「重载」。
- 只显示文本与工具调用名，不渲染富内容、图片、diff。
- `session/prompt` 的 `mode` 固定 `queue`，没有 steer。
- 鉴权只校验本机 `dsh-auth-*` cookie 是否存在，不验签。本机 Host 默认绑回环，够用；
  如果本机 Host 也开在局域网上，必须在前面加自己的 Origin 校验。
- 远端 token 每次启动变化，没有自动重新获取的机制。

## 已验证的事实

- token → cookie：`GET /?token=` 返回 303 + `Set-Cookie: dsh-auth-...`，payload 绑定 `authority`。
- 一元调用：`POST /api/<endpoint>`，body `{type:'client-request', rpcId, method, payload:{args}}`，
  回 `{type:'server-response', result:{ok, value}}`。
- `session/list` 需要 `{_request:{}}`；`session/page` 需要
  `{request:{address:{kind:'session',sessionId}, throughSeq, maxMessages}}`。
- 侧边栏入口与主面板在 headless Chrome 里实际渲染出来，远端历史实际读到 152 条记录。
