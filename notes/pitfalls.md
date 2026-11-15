# 踩过的坑

每条都是实际撞上的，记现象 + 解法，省得重走一遍。

## 插件加载

### 1. client 插件必须导出 `inject: ['slots']`

现象：整个网页白屏报

```
Failed to load plugins
dsh-remote-sessions: failed
```

控制台才给出真话：

```
Error: cannot get property "slots" without inject
```

原因：cordis 的 ctx 属性访问有保护，没在 `inject` 里声明的服务不能读。

解法：

```js
exports.apply = apply
exports.inject = ['slots']
```

参考：`ui-sidebar-browser/lib/client.js` 里是 `const inject = ["slots", "locale", "sidebarRight", ...]`。

### 2. client 插件 apply 抛错会拖垮整个界面

现象同上，一屏 "Failed to load plugins"，连会话都打不开。因为是 boot 阶段一个 entry 没激活。

解法：apply 里整体 try/catch，**打完日志不要再抛**。

```js
try { ... } catch (error) {
  console.error('[remote-sessions] apply failed:', (error && error.stack) || error)
  // 不要 throw
}
```

### 3. package.json 声明了 `dsh.client` 就必须有 `lib/client.js`

现象：启动直接失败

```
client-modules: client bundle not found; run `pnpm run build` before launch
  package: dsh-remote-sessions
  path: .../lib/client.js
```

解法：先放个最小可用的 client.js（哪怕只有一个空 `apply`），再迭代。

### 4. 插件包别依赖 `@deepseek-ai/*` 运行时包

现象：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
 imported from .../plugins/dsh-remote-sessions/lib/index.js
```

原因：插件用软链放进 profile 的 `node_modules`，ESM 按**真实路径**（workspace 里）解析，
往上级目录找不到 profile 的 node_modules。

解法：host 插件不 import 任何 `@deepseek-ai/*` 包，config 自己处理默认值：

```js
function apply(ctx, rawConfig) {
  const config = { hosts: [], requestTimeoutMs: 20000, ...(rawConfig ?? {}) }
}
```

不再导出 `Config`（schemastery schema）。cordis 没有 Config 也能跑。

## webserver 路由

### 5. `handler` 是 node 风格，不是 Fetch 风格

`webServer.register()` 的 route 有两个座位：

```js
// node 风格：拿到的是 http.IncomingMessage / ServerResponse
{ kind: 'exact', path: '/x', methods: ['GET'], handler: (req, res) => { res.end('hi') } }

// Fetch 风格：拿到的是 Request，返回 Response
{ kind: 'prefix', path: '/y', resource: (request) => new Response('hi') }
```

我一开始把 `handler` 当成 `(request, peer)` 写、`return Response.json(...)`，
结果请求**挂起 60 秒**——返回的 Response 没人消费，socket 一直不关。

### 6. `resource` 在实际请求下会 400

同样的路由改成 `resource` 风格后，返回空的 HTTP 400。连「返回固定字符串」的最简 resource 都 400，
说明异常发生在 `serveResource` 内部（`Headers` 构造或 `new Request(...)`），我的函数压根没被调用。
具体原因没查到根，改用 node 风格 `handler` 一切正常。

**结论：这个版本的 webserver 用 `handler` 更省事，还能顺手支持 POST。**

### 7. `resource` 拿不到 peer

`serveResource` 内部是：

```js
await resource(new Request(target, { method, headers, signal }))
```

**只传了一个参数**，没有 peer。所以想用 `(request, peer)` 判断「是不是已认证的浏览器」行不通，peer 永远 undefined。

解法：`handler` 里查 cookie 前缀：

```js
function authorized(req) {
  const cookie = req.headers.cookie ?? ''
  return /(?:^|;\s*)dsh-auth-[^=;]+=/.test(cookie)
}
```

（只查存在性，不验签。本机 Host 绑回环时够用。）

## client bundle

### 8. `/plugins/...` 必须带精确 rev，且用 `??` 形式

现象：`/plugins/dsh-remote-sessions/client.js` 404，官方包也一样 404。

原因：bundle 表按**完整 URL**（含 search）做 key：

```js
const response = this.responses.get(resourceUrl) ?? ... ?? this.chunkResponse(requestUrl)
```

可用 URL 长这样（从 index.html 的 `__DSH_BOOT__` 里抄）：

```
/plugins/??dsh-remote-sessions/client.js&rev=d6742dcf624e
```

带这个能 200。

## 版本 / 命令行

### 9. `--profile` 后面别再跟应用名

```bash
dsh --profile rstest web --port 53998   # ✗ error: too many arguments
dsh --profile rstest --port 53998       # ✓
```

`--profile <name>` 已经决定了跑哪个应用，后面直接跟该应用的参数。

### 10. `session/events` 在 0.2.1 不存在

打过去是纯文本 404 `not found`（不是 JSON 错误）。0.2.1 用 `session/page`。
插件里先试 events，失败回退 page。

### 11. token 是一次性的

同一个 token 第二次换 cookie 会被拒，页面显示 `dsh web authentication required`。
重启实例拿新的。

## 测试手法

### 12. macOS 没有 `timeout` 命令

`timeout 45 cmd` 直接 exit 127。用 python `subprocess.run(..., timeout=)` 包一层。

### 13. headless Chrome `--dump-dom` 会卡死

DSH 页面有长连接（WebSocket），`--dump-dom` / `--virtual-time-budget` 等不到 load 完成，
60 秒超时且零输出。

解法：用 CDP。起 `--remote-debugging-port=9333`，然后 Node 内置的 `WebSocket`（node 22+ 自带）
连 `/json/new` 拿到的 `webSocketDebuggerUrl`，发 `Runtime.enable` / `Page.navigate` /
`Runtime.evaluate`。这样还能顺便抓 `Runtime.consoleAPICalled` 里的真实报错——上面第 1 条就是这么抓到的。

### 14. 别拿真实会话测发消息

测试用第二个 DSH 实例当「远端」时，它和桌面版共用 `$DSH_HOME/sessions`，
`session/prompt` 会真的往同一条会话日志里写一条 user 消息。要么另开会话测，要么换真机。

## 面板注册的正确写法

```js
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '远程' },
    IconComponent,
  ),
)

ctx.slots.inject('main', () =>
  ctx.slots.register(
    { name: 'main', key: PANEL_ID },
    PageComponent,
  ),
)
```

- `label` 用**函数**（官方都用 `label: () => t('panel')`）
- 第二个参数是 React 组件本身
- `main` 的 `key` 要跟 `sidebar.panellist` 的 `id` 对上
- client bundle 里只能用 `react.createElement`（没有 JSX 编译）、
  模块形式是 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`
