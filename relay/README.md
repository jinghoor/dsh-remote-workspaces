# 中转（relay）

两台机器都不用开端口：远端跑 `agent` 主动连出，本机跑 `client` 主动连出，中转只负责配对和转发字节。

```
本机插件 → http://127.0.0.1:52900
              │  client（主动外连 TLS）
              ▼
        <relay>:19090  relay（systemd: dsh-relay）
              ▲
              │  agent（主动外连 TLS）
        远端 DSH  →  127.0.0.1:52893
```

因为是**透明 TCP**，DSH 的 token/cookie 鉴权、甚至 WebSocket mux 都原样穿透。

## 已部署

| 项 | 值 |
|---|---|
| 地址 | `<relay>:19090` |
| 服务 | `/etc/systemd/system/dsh-relay.service`（已 enable，重启自动起） |
| 目录 | `/opt/dsh-relay/`（`relay.mjs`、`dsh-relay.mjs`、`cert.pem`、`key.pem`、`secret`） |
| 防火墙 | `ufw allow 19090/tcp` |
| 证书 | 自签 10 年，客户端按指纹校验（不是 CA 校验） |

具体指纹和 secret 在同目录 `DEPLOYED.md`。

## 远端跑 DSH 的必要参数

中转是**透明 TCP**：本机 client 发出去的 `Host` 头是 `127.0.0.1:52900`，而远端的 DSH 听在 `52893`。
DSH 的 `/api` 有一道 browser-trust fence，authority 对不上会直接 401。
所以远端启动 DSH 必须把这些 authority 加进白名单：

```bash
dsh --profile web --port 52893 --host 127.0.0.1 --no-open \
  --trusted-host 127.0.0.1:52900 --trusted-host localhost:52900
```

端口固定（否则随机端口一重启就变），并把启动输出的 `?token=...` 存下来：

```bash
... 2>&1 | tee /tmp/dsh-web.log
grep -o 'token=[A-Za-z0-9_-]*' /tmp/dsh-web.log | head -1
```

token 每个进程一个，DSH 重启就换。

## 远端装（有 DSH 的那台）

```bash
curl -k -o dsh-relay.mjs https://<relay>:19090/dsh-relay.mjs
node dsh-relay.mjs agent \
  --relay <relay>:19090 \
  --secret <AGENT_SECRET> \
  --device desk \
  --local 127.0.0.1:52893 \
  --fingerprint <证书指纹>
```

或者用安装脚本（会下到 `~/.dsh-relay/`、可后台常驻）：

```bash
./install.sh agent --device desk --local 127.0.0.1:52893 \
  --secret <AGENT_SECRET> --fingerprint <指纹> --daemon
```

## 本机装（看界面那台）

```bash
./install.sh client --device desk --listen 127.0.0.1:52900 \
  --secret <AGENT_SECRET> --fingerprint <指纹> --daemon
```

然后插件里主机地址填 `http://127.0.0.1:52900`，token 填远端 DSH 启动时打印的那串。

## 设备名

`--device` 是配对键：agent 和 client 用同一个名字才连到一起。多台远端就起多个 agent，各用不同 `--device`，本机对这些 device 各起一个 client（不同 listen 端口），插件里配多条主机。

## token 自动同步（可选）

远端 DSH 重启会换 token。让 agent 盯着 DSH 的启动日志，就能自动把新 token 送到本机，
不用人再复制粘贴：

```bash
# 远端：把启动输出落盘，agent 读它
dsh --profile web --port 52893 --host 127.0.0.1 --no-open \
  --trusted-host 127.0.0.1:52900 --trusted-host localhost:52900 2>&1 | tee logs\dsh-web.log

node dsh-relay.mjs agent --relay ... --device desk \
  --local 127.0.0.1:52893 --token-file logs\dsh-web.log --fingerprint ...
```

```bash
# 本机：收到新 token 直接写进插件配置
node dsh-relay.mjs client --relay ... --device desk --listen 127.0.0.1:52900 \
  --config ~/.dsh/profiles/desktop/remote-workspaces.json --host-id desk --fingerprint ...
```

链路：agent 每 5 秒读一次日志 → 变了就推给中转 → 中转转给该 device 的所有 client →
client 改配置文件 → 插件监听到文件变化自动重载。**全程不需要重启 DSH。**

## 直连桌面版（无 token 的 Host）

桌面版内嵌的 host 不打印 token，但它的浏览器 cookie 明文存在 Chromium 的 cookie 库里，
agent 可以直接读出来经中转推给本机 —— **不用手工传凭据**：

```bash
# 远端：--local 指向桌面版 host 的端口
node dsh-relay.mjs agent --relay <relay>:19090 --secret <S> --device desk \
  --local 127.0.0.1:<桌面版端口> --fingerprint <FP>
```

agent 会每 5 秒扫一次 cookie 库（macOS/Linux/Windows 路径自动判断，也可 `--cookie-db` 指定），
找到该 authority 的有效 cookie 就推给中转；本机 client 收到后写进插件配置：

```json
{ "id": "desk", "baseUrl": "http://127.0.0.1:52900", "cookie": "dsh-auth-...=v1...", "authority": "127.0.0.1:<桌面版端口>" }
```

`authority` 让插件发的请求带上远端那个 Host 头，所以**本机监听端口不必和远端一致**。
插件监听到配置文件变化会自动重载，无需重启。

好处：隧道打到的就是桌面版自己那个 Host，只有一个进程在写会话，不会出现 `session/writer-held`。

## 运维

```bash
systemctl status dsh-relay          # 服务器上
journalctl -u dsh-relay -n 50       # 日志
```

轮换 agent 密钥：改 `/opt/dsh-relay/secret` 后
`systemctl restart dsh-relay`，再把新值发给 agent 端。

## 鉴权细节（实测）

- token 只在 `GET /` 上被接受；带在别的路径上一律 401。
- cookie 与 **authority** 绑定：`127.0.0.1:52900` 与 `localhost:52900` 是两个不同的 cookie。
  插件必须全程用同一个 authority，否则 401 看起来跟"token 错"一模一样。
- 另有 `GET /connect?token=…&interactions=answer` → 302 + v2 cookie（API 客户端用）。
  v1（`/` 换的）和 v2 都能调 RPC；插件用 `/`。
- `SameSite=Strict`。

## 安全边界

- agent 角色有共享密钥；client 角色没有，但 client 连到的只是 DSH，DSH 自己要求 token/cookie 才能用。
- 传输是 TLS，两端用**证书指纹固定**（`--fingerprint`），不做 CA 校验——固定指纹的目的就是防止中间人换证书。
- 中转不落盘任何内容，只在内存里转字节。
- 暴露面是一个端口 + 一个自签 TLS 服务，除了配对没有别的接口。

## 自启动

macOS 用 LaunchAgent，Linux 用 `systemctl --user`。示例（macOS）：

```bash
cat > ~/Library/LaunchAgents/com.dsh.relay.agent.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dsh.relay.agent</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v node)</string>
    <string>$HOME/.dsh-relay/dsh-relay.mjs</string>
    <string>agent</string><string>--relay</string><string><relay>:19090</string>
    <string>--secret</string><string>&lt;AGENT_SECRET&gt;</string>
    <string>--device</string><string>desk</string>
    <string>--local</string><string>127.0.0.1:52893</string>
    <string>--fingerprint</string><string>&lt;指纹&gt;</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/com.dsh.relay.agent.plist
```

## 远端端点文件（A 方案，推荐）

某些系统上 Chromium 独占 Cookies 库，agent 读不到。此时让远端维护一个端点文件：

```json
{ "authority": "127.0.0.1:55455", "cookie": "dsh-auth-...=v1..." }
```

agent 每 5 秒读一次（`--endpoint-file <path>`），内容变化就以 COOKIE 帧推给中转；
本机 client 收到后写进插件配置的 `cookie` + `authority`，插件热重载。

```bash
node dsh-relay.mjs agent --relay <relay>:19090 --secret <S> --device desk \
  --local 127.0.0.1:55455 --endpoint-file data/remote-endpoint.json --fingerprint <FP>
```

`authority` 决定插件发出请求的 Host 头，因此本机监听端口不必与远端一致。


## 账号（多用户 / 数据隔离）

一把共享 secret 只适合单人。账号模式下：

```bash
# 注册 / 登录（两端都做，用同一个账号）
node dsh-relay.mjs register --relay HOST:19090 --user alice
node dsh-relay.mjs login    --relay HOST:19090 --user alice

# 这台机器是「远端端」还是「本地端」——登录后设一次，之后随时改
node dsh-relay.mjs setup                       # 交互
node dsh-relay.mjs setup --role agent  --device desk --local 127.0.0.1:52893
node dsh-relay.mjs setup --role client --device desk --listen 127.0.0.1:52900

node dsh-relay.mjs config                      # 查看
node dsh-relay.mjs config --role client        # 只改角色
node dsh-relay.mjs start                       # 按配置启动
```

配置存在 `~/.dsh-relay/config.json`（0600），含 relay 地址、证书指纹、账号 token、角色、设备名、端口。

### 隔离规则

| 场景 | 结果 |
|---|---|
| 同一账号的两台设备 | 互通（`alice` 的 agent ↔ `alice` 的 client） |
| 不同账号的 client 连别人的设备 | 拒绝：`not a device of <user>` |
| 不同账号的 agent 抢占已绑定的设备名 | 拒绝：`device belongs to another account` |
| 无凭据 client（旧版） | 只能连**同一共享密钥**注册的 legacy 设备 |

设备名在第一次成功连上时绑定到账号（`devices.json` 里记录 owner），之后其他账号无法复用。
密码用 scrypt 加盐哈希；token 是 HMAC 签名的 JSON，默认 30 天，relay 重启不掉线。

### 服务端文件

```
/opt/dsh-relay/users.json    账号 + 设备归属（0600）
/opt/dsh-relay/token.key     token 签名密钥（0600，首次启动自动生成）
```

`users.json` 就是账号数据库，备份它 + `token.key` 即可整体迁移。
