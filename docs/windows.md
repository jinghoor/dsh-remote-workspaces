# Windows 端安装（远端那台）

远端这台机器只有一个职责：把本机的 DSH 接进隧道，让另一台电脑看到它。
**不需要**在这台装任何图形界面，除非你也想在 Windows 上用设置页管理。

两种方式选其一：

- **方案 A —— 只装 CLI 引擎**（推荐）：一条命令拉起，用任务计划开机自启。
- **方案 B —— 也装 DSH 插件**：Windows 上的 DSH 设置页里同样能登录/选角色/启停。

---

## 前置

1. **Node.js 18+**（`node -v` 能输出版本即可）。没有就装 LTS：
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
2. **DSH 桌面版正在运行**（隧道要连它）。

---

## 方案 A：只装 CLI 引擎

### 1. 下载引擎

```powershell
$dir = "$env:USERPROFILE\.dsh-relay"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
curl.exe -k -o "$dir\dsh-relay.mjs" https://<relay>:19090/dsh-relay.mjs
node "$dir\dsh-relay.mjs"            # 打印用法即下载成功
```

> `-k` 是因为中转用的是自签证书；指纹在第一次连接时会被校验并记录在配置里。

### 2. 登录（与本地端同一个账号）

```powershell
node "$dir\dsh-relay.mjs" login --relay <relay>:19090 --user <你的账号>
```

没账号就先注册（在任一台上注册一次即可）：

```powershell
node "$dir\dsh-relay.mjs" register --relay <relay>:19090 --user <你的账号>
```

密码会提示输入，不回显。凭据写进 `%USERPROFILE%\.dsh-relay\config.json`。

### 3. 设为「远端端」

```powershell
node "$dir\dsh-relay.mjs" setup --role agent --device desk --local auto
```

- `--device` 是这台机器的名字，本地端连它时用同一个名字
- `--local auto` 表示**自动跟随桌面版端口**。DSH 桌面版每次启动会换端口，
  `auto` 会从 cookie 库里读出当前端口（实测日志：`DSH 端口: auto → 127.0.0.1:59708`），
  且每 10 秒复查一次，桌面版重启后自动跟上

### 4. 启动

```powershell
node "$dir\dsh-relay.mjs" start
```

看到这两行就通了：

```
agent connected to <relay>:19090 as "desk" → 127.0.0.1:59708
published cookie for 127.0.0.1:59708 (226 chars)
```

### 5. 开机自启（任务计划）

```powershell
$action  = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument "`"$env:USERPROFILE\.dsh-relay\dsh-relay.mjs`" start"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$set     = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "DSH Relay Agent" -Action $action -Trigger $trigger -Settings $set -Force
Start-ScheduledTask -TaskName "DSH Relay Agent"
```

登录后自动跑，挂了会自动重启。

---

## 方案 B：也装 DSH 插件（图形界面）

插件本体是一个目录 + 一条 patch 记录；`install.sh` 是 bash，Windows 上手动做等价的两步。

### 1. 把插件目录拷进去

在**本机**（macOS）执行，直接把源码目录推过去：

```bash
scp -r "plugin" <windows用户>@<windows主机>:"C:/Users/<windows用户>/.dsh/profiles/desktop/plugins/dsh-remote-workspaces"
```

或者在 Windows 上从仓库克隆/解压到：

```
C:\Users\<你>\.dsh\profiles\desktop\plugins\dsh-remote-workspaces\
    ├─ package.json
    └─ lib\
        ├─ index.js  client.js  remote.mjs  ws.mjs  config.mjs
        └─ tunnel.mjs  dsh-relay.mjs        ← 隧道引擎随插件一起装
```

### 2. 让加载器认得这个包名

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Directory -Force -Path "$profile\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-remote-workspaces" `
  -Target "$profile\plugins\dsh-remote-workspaces"
```

（Windows 上 `New-Item -ItemType Junction` 等价于 Unix 的软链。）

### 3. 在 patch 里登记

编辑 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，在 `insert:` 段追加：

```yaml
- insert:
    - id: dsh-remote-workspaces
      name: dsh-remote-workspaces
```

> `name` 是必填：loader 用 `import(this.options.name)` 解析插件包，
> 只写 `id` 会静默解析不到，插件看起来"装了但没生效"。

已存在就跳过——这里只允许一条，重复会变成多层包装（这个坑在 `.work/review/notes.md` 里记过）。

### 4. 重启 DSH 桌面版

设置里会出现两个分区：**账号与隧道** 与 **远程主机**。在 Windows 这台：

- 登录同一个账号
- 角色选「远端端（这台跑 DSH）」
- 设备名填 `desk`，地址填 `auto`
- 勾「DSH 启动时自动运行隧道」，点保存 → 启动

---

## 验证

在**本地端**（macOS）跑：

```bash
node scripts/verify.mjs --port <本机 DSH 端口>
```

或直接看设置页「账号与隧道」的运行日志，出现 `client attached to … for "<账号>/desk"` 即为连上。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `找不到 DSH 端口` | 桌面版没跑，或 cookie 库里没有有效凭据 | 先开 DSH 桌面版；确实不行就手动写 `--local 127.0.0.1:<端口>` |
| `client desk rejected: not a device of <user>` | 两端不是同一个账号 | 两端重新 `login` 同一账号 |
| `agent desk rejected: device belongs to another account` | 同名设备已被别的账号占用 | 换一个 `--device` 名字 |
| 连上了但侧边栏没有工作区 | 本地端插件没收到凭据 | 看本地端设置页日志有无 `updated cookie for "desk"` |
| 重启桌面版后断了 | 旧版本没有 `auto` | 用当前 `--local auto` 或重新 `setup` |
