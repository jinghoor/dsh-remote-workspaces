# DSH 远端 Host HTTP/RPC 协议（实测）

全部是实际跑出来的结果，不是从文档推的。测试环境：
node 版 dsh `0.2.1-rc.5`，默认 `dsh --profile web` 监听 `127.0.0.1:53999`。

## 1. 认证：token 换 cookie

```bash
curl -i -c cookie.txt "http://127.0.0.1:53999/?token=<启动时打印的 token>"
```

响应：

```
HTTP/1.1 303 See Other
location: ./
set-cookie: dsh-auth-<随机名>=v1.<base64payload>.<签名>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
```

payload 解出来：

```json
{"version":1,"authority":"127.0.0.1:53999","issuedAt":1794648005012,"expiresAt":1797240005012}
```

要点：

- cookie 名带随机后缀，前缀固定 `dsh-auth-`
- `authority` 是**请求的 Host**，不是监听地址。所以走 SSH 隧道时，
  从 `127.0.0.1:52900` 访问拿到的 cookie 里 `authority` 就是 `127.0.0.1:52900`，
  远端签发的 cookie 会跟着隧道端口走，不需要 `--trusted-host`
- token 在启动时打印，**每次启动都变**
- 同一 token 用第二次会失效（一次性），必须重启实例拿新的

## 2. RPC 信封

一元调用走 `POST /api/<endpoint>`。endpoint 里的 `/` 原样保留（`session/list` → `/api/session/list`）。

请求：

```json
{
  "type": "client-request",
  "rpcId": "<任意字符串，回显用>",
  "method": "<必须与路径里的 endpoint 完全一致>",
  "payload": { "args": { ... } }
}
```

注意 `payload` 外面必须包一层 `args`，直接放参数会报：

```
gateway/internal: Remote payload must contain exactly one plain-object args field
```

成功响应：

```json
{"type":"server-response","rpcId":"...","result":{"ok":true,"value":{...}}}
```

失败响应：

```json
{"type":"server-response","rpcId":"...","result":{"ok":false,
  "error":{"code":"gateway/arguments-invalid","message":"...","details":{...}}}}
```

常见错误码：

| code | 含义 |
|---|---|
| `gateway/internal` | 信封结构不对（多半是少了 `args` 那层） |
| `gateway/arguments-invalid` | 参数名与 descriptor 不匹配，message 里会列出 missing / unexpected |
| `gateway/input-invalid` | 参数名对但类型不对（"failed boundary validation"） |
| `gateway/bad-request` | `method` 和路径里的 endpoint 不一致 |

**404 而且是纯文本 `not found`** = 这个 endpoint 在该版本不存在（不是参数问题）。

`origin` 头不是必须的。带上也无害。

## 3. endpoint 与参数

### session/list

```json
{"args": {"_request": {}}}
```

返回 `{items: [...]}`，每项大致：

```json
{
  "sessionId": "session-...",
  "updatedAt": 1794647787874,
  "agentAvailable": false,
  "running": false,
  "blank": false,
  "cwd": "/path",
  "formatStatus": "current",
  "projections": {
    "kind": "cached",
    "asOfSeq": 305,
    "values": {
      "title": "...",
      "tokenUsage": {...},
      "turnOutline": [{"turn":1,"seq":4,"prompt":"...","response":"..."}]
    }
  }
}
```

`projections.asOfSeq` 是拿历史页要用的 `throughSeq`。

### session/page（0.2.1）

```json
{"args": {"request": {
  "address": {"kind": "session", "sessionId": "session-..."},
  "throughSeq": 305,
  "maxMessages": 120
}}}
```

`throughSeq` **必填**，表示日志切点。省略或给 0 只会拿到 seq 0 那一两条。
`beforeSeq` 可选，用于往前翻页。

返回：

```json
{"records":[{"type":"event","event":{"type":"assistant/message","seq":256,"time":...,"data":{...}}}],
 "hasMore":true}
```

### session/events（0.2.2）

新版名字，形状相同（`{request:{address, throughSeq, maxMessages}}`）。
0.2.1 上不存在，会 404。插件里做了自动回退。

### session/prompt——**未实测**

从 descriptor 的 jsonSchema 读出来的：

```json
{"args": {"request": {
  "requestId": "<客户端生成的唯一 id>",
  "sessionId": "session-...",
  "mode": "queue",
  "content": [{"type": "text", "text": "..."}],
  "clientTimeZone": "Asia/Shanghai"
}}}
```

`mode` 只能是 `queue` 或 `steer`。`content` 至少一个非空白 text 或附件。

## 4. 事件类型（历史记录里出现的）

实测一页 152 条记录里出现的 `event.type`：

```
assistant/message   含 message.content[]，块类型有 reasoning / text / tool-call
tool/call           data: {turn, step, callId, name, arguments(JSON 字符串)}
tool/result
step/start, step/end
job/registered, job/settled
permission/preset   seq 0，会话开头的预设记录
```

`assistant/message` 的 `data.message.content` 是数组，只取 `type === 'text'` 的渲染正文，
`reasoning` 块不显示。

## 5. Web GUI 的其它路径

| 路径 | 说明 |
|---|---|
| `/?token=` | 换 cookie，303 到 `./` |
| `/api/<endpoint>` | RPC 一元调用 |
| `/api/remote.mux` | WebSocket，Remote 流（本插件没用到） |
| `/plugins/??<pkg>/client.js&rev=<hash>` | 客户端插件 bundle，**必须带精确 rev** |
| `/assets/index-*.js` | Web shell 本体 |

`/plugins/<pkg>/client.js` 不带 `??` 或 `rev` 一律 404——bundle 表是按完整 URL 做 key 的。
可用 URL 从 `GET /` 返回的 index.html 里 `__DSH_BOOT__` 找。
