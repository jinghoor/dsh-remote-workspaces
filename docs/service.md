# 把中转当公共服务运营

插件里已经内置了默认中转地址与证书指纹，所以用户装完插件只需要**注册/登录**就能用：

```
设置 → DSH远程客户端 → 账号：注册（或登录）→ 这台机器的角色 → 保存并启动
```

用户不需要知道中转地址，也不需要自己部署。这份文档写给**中转的运营者**。

## 现在的默认配额

跑的是 `relay/relay.mjs` 的默认值（改 systemd 参数可覆盖）：

| 参数 | 默认 | 含义 |
|---|---|---|
| `--max-devices` | 8 | 每个账号最多几台设备（第一个连上的会占用一个名额） |
| `--max-links` | 16 | 每个账号同时最多几条 client 连接 |
| `--register-per-hour` | 5 | 同一来源 IP 每小时最多注册几个账号 |
| `--no-register` | 关 | 打开后彻底关闭自助注册 |

登录还有一层独立限速：同一 (IP + 账号) 5 分钟内 10 次失败即 `429`。

## 一次真实的连接过程

```
1. 用户在插件里注册 → POST /v1/register → 返回签名 token（存进 ~/.dsh-relay/config.json）
2. 被看的那台：选「远程端」，启动 → agent 主动外连 relay，认领设备名
3. 查看的那台：选「本地端」，启动 → client 主动外连 relay，配对同一账号的设备
4. relay 把两端的字节对转；agent 把远端 DSH 的 token/cookie 推给 client
5. 插件把凭据写进 remote-workspaces.json，侧边栏出现远端工作区
```

全程两端**都不需要开放端口**，也都不需要公网 IP。

## 你作为运营者需要管的三件事

**1. 带宽**

同步才走流量，空闲时几乎为零。实测参考：

- 一次会话列表刷新 ≈ 380 KB（250 条会话）
- 图片/文件上传最大 50 MB
- 模型推理**不经过**中转（远端 DSH 自己连模型服务商）

**2. 滥用**

这是必须正视的部分：**一个开放的中转，本质上是一个开放的 TCP 隧道**。
本仓库的 agent 只连本机 DSH，但 agent 是开源的——有人改一版让它连任意本地端口，
就能把你的中转当成免费代理用。

可用的手段（按见效顺序）：

```bash
# 每个账号同时最多一条连接：跑不了并发大流量
--max-links 1

# 收紧注册
--register-per-hour 1

# 彻底关闭自助注册，只留白名单账号
--no-register --allow-users alice,bob
```

再看审计日志定位：

```bash
journalctl -u dsh-relay | grep -E "registered|login|agent online" | tail -50
```

每条都带来源 IP（`from x.x.x.x`）。要临时停掉某个账号：

```bash
dsh-relay revoke --user NAME --secret <relay密钥>      # 立刻断开它所有活连接
dsh-relay user remove --user NAME --secret <relay密钥>  # 连账号一起删
```

**3. 成本**

单个中转进程实测：`RSS ≈ 65 MB`、`CPU ≈ 0.3%`、磁盘 160 KB（代码 + 账号库）。
主要成本是带宽，不是机器。

## 上线检查清单

```bash
# 1. 证书与指纹
openssl x509 -in /opt/dsh-relay/cert.pem -noout -fingerprint -sha256

# 2. 插件里的默认地址要和服务器一致
grep -n "DEFAULT_RELAY\|DEFAULT_FINGERPRINT" plugin/lib/defaults.mjs

# 3. 配额符合预期
systemctl cat dsh-relay | grep ExecStart

# 4. 账号库备份（里面有设备归属，丢了用户要重新认领）
cp /opt/dsh-relay/users.json /opt/dsh-relay/token.key /backup/
```

## 换地址怎么办

1. 改 `plugin/lib/defaults.mjs` 里的 `DEFAULT_RELAY` / `DEFAULT_FINGERPRINT`
2. 发新版（`docs/publishing.md`）
3. 老用户可以在「高级设置」里手填新地址，或用 `dsh-relay config --relay …`

## 服务条款要点（建议写进你的页面）

- 中转只转发字节，不存储会话内容
- 账号仅用于配对设备，请不要用于其他用途
- 单账号有设备数/并发数配额，超限会被拒绝
- 滥用（例如把中转当作通用代理）会被吊销账号
