window.__ModuleLoader__.load({
  id: 'dsh-remote-workspaces',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var react = require('react')
    var h = react.createElement

    var SECTION_ID = 'remote-hosts'

    var PROJECT = {
      name: 'DSH远程客户端',
      repo: 'https://github.com/jinghoor/dsh-remote-workspaces',
      mail: '277030704@qq.com',
      qq: '587118291',
      qqName: 'DSH远程客户端插件交流群',
    }

    var styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 880 },
      card: {
        border: '1px solid var(--dsh-border-subtle, rgba(255,255,255,.07))',
        borderRadius: 14,
        background: 'var(--dsh-surface-raised, rgba(255,255,255,.03))',
        overflow: 'hidden',
      },
      headRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px' },
      cardTitle: { fontSize: 14, fontWeight: 600 },
      hint: { fontSize: 12.5, color: 'var(--dsh-text-secondary, rgba(255,255,255,.55))' },
      host: { padding: '16px 20px' },
      hostTop: { display: 'flex', alignItems: 'center', gap: 10 },
      name: { fontSize: 15, fontWeight: 600 },
      status: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.75 },
      dot: { width: 6, height: 6, borderRadius: '50%' },
      acts: { marginLeft: 'auto', display: 'flex', gap: 8 },
      button: {
        height: 28,
        padding: '0 11px',
        borderRadius: 8,
        border: '1px solid var(--dsh-border-subtle, rgba(255,255,255,.14))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      buttonGhost: { borderColor: 'transparent', opacity: 0.7 },
      kv: { display: 'flex', gap: 12, marginTop: 10, fontSize: 12.5 },
      key: { width: 44, flex: '0 0 44px', opacity: 0.5 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, opacity: 0.85 },
      subhead: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px 8px', borderTop: '1px solid var(--dsh-border-subtle, rgba(255,255,255,.07))', fontSize: 12, opacity: 0.7 },
      wsRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 20px', fontSize: 13 },
      check: { width: 15, height: 15, flex: '0 0 15px', borderRadius: 4, border: '1px solid rgba(255,255,255,.28)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
      checkOn: { background: 'rgba(255,255,255,.28)', borderColor: 'rgba(255,255,255,.42)' },
      wsPath: { fontSize: 11.5, opacity: 0.45, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      wsCount: { marginLeft: 'auto', fontSize: 11.5, opacity: 0.45 },
      addRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--dsh-border-subtle, rgba(255,255,255,.07))', fontSize: 13, cursor: 'pointer', opacity: 0.8 },
      form: { display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 20px', borderTop: '1px solid var(--dsh-border-subtle, rgba(255,255,255,.07))' },
      field: { display: 'flex', alignItems: 'center', gap: 12 },
      label: { width: 64, flex: '0 0 64px', fontSize: 12.5, opacity: 0.6 },
      input: {
        flex: '1 1 auto',
        height: 30,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsh-border-subtle, rgba(255,255,255,.14))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        fontFamily: 'inherit',
      },
      error: { padding: '10px 20px', color: '#f87171', fontSize: 12, whiteSpace: 'pre-wrap' },
      ok: { padding: '0 20px 12px', color: '#6ee7a8', fontSize: 12 },
      foot: { fontSize: 11.5, opacity: 0.45, padding: '0 2px' },
      about: { padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 },
      aboutTop: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'nowrap' },
      aboutTitle: { fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' },
      versionChip: {
        fontSize: 11,
        lineHeight: '18px',
        padding: '0 7px',
        borderRadius: 999,
        background: 'var(--dsh-surface-sunken, rgba(255,255,255,.06))',
        color: 'var(--dsh-text-secondary, rgba(255,255,255,.62))',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      aboutLinks: { display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' },
      aboutItem: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12.5,
        color: 'var(--dsh-link, #6aa9ff)',
        textDecoration: 'none',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      row: { display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 140 },
      fieldLabel: { fontSize: 11.5, color: 'var(--dsh-text-secondary, rgba(255,255,255,.55))' },
      radio: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer' },
      details: {
        border: '1px solid var(--dsh-border-subtle, rgba(255,255,255,.07))',
        borderRadius: 14,
        background: 'var(--dsh-surface-raised, rgba(255,255,255,.02))',
        overflow: 'hidden',
      },
      summary: {
        padding: '13px 20px',
        fontSize: 13,
        cursor: 'pointer',
        color: 'var(--dsh-text-secondary, rgba(255,255,255,.6))',
        userSelect: 'none',
      },
      cardPadBottom: { paddingBottom: 16 },
      log: {
        margin: 0,
        padding: '0 20px 16px',
        fontSize: 11.5,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        color: 'var(--dsh-text-secondary, rgba(255,255,255,.6))',
        maxHeight: 220,
        overflow: 'auto',
      },
    }

    async function api(path, init) {
      const res = await fetch(path, { credentials: 'same-origin', ...(init ?? {}) })
      const body = await res.json().catch(() => null)
      if (!res.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${res.status}`)
      return body.value
    }

    /** 顶部「关于」用的三个 16px 图标：GitHub 标记、信封、聊天气泡。 */
    function IconGithub(props) {
      return h('svg', { width: props?.size ?? 15, height: props?.size ?? 15, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true', style: { flex: '0 0 auto' } },
        h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z' }))
    }

    function IconMail(props) {
      return h('svg', { width: props?.size ?? 15, height: props?.size ?? 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { flex: '0 0 auto' } },
        h('rect', { x: 1.5, y: 3.2, width: 13, height: 9.6, rx: 2 }),
        h('path', { d: 'M2.4 4.6 8 8.6l5.6-4' }))
    }

    function IconChat(props) {
      return h('svg', { width: props?.size ?? 15, height: props?.size ?? 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { flex: '0 0 auto' } },
        h('path', { d: 'M2 4.2A2.2 2.2 0 0 1 4.2 2h7.6A2.2 2.2 0 0 1 14 4.2v4.4a2.2 2.2 0 0 1-2.2 2.2H7.4L4 13.4V10.8h-.2A1.8 1.8 0 0 1 2 9V4.2z' }))
    }

    /** 远程端：显示器；本地端：笔记本。纯几何图形，跟主题色走。 */
    function IconMonitor(props) {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('rect', { x: 1.6, y: 2.6, width: 12.8, height: 8.4, rx: 1.6 }),
        h('path', { d: 'M6 13.4h4' }))
    }

    function IconLaptop(props) {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('rect', { x: 3, y: 3.2, width: 10, height: 7, rx: 1.4 }),
        h('path', { d: 'M1.6 12.4h12.8l-1.2 1.4H2.8z' }))
    }

    function Check(props) {
      return h('span', { style: { ...styles.check, ...(props.on ? styles.checkOn : {}) } },
        props.on ? h('svg', { width: 9, height: 9, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 3 }, h('path', { d: 'M5 12.5l4.5 4.5L19 7' })) : null)
    }

    function HostCard(props) {
      const host = props.host
      // 工作区列表默认展开：这里就是用户最常看的那一屏，多一次点击没意义。
      const [open, setOpen] = react.useState(true)
      const [items, setItems] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [note, setNote] = react.useState(null)
      const [error, setError] = react.useState(null)

      const loadWorkspaces = react.useCallback(() => {
        setBusy(true)
        setError(null)
        api(`/remote-workspaces/workspaces?host=${encodeURIComponent(host.id)}`)
          .then((value) => setItems(Array.isArray(value?.items) ? value.items : []))
          .catch((e) => setError(String(e.message ?? e)))
          .finally(() => setBusy(false))
      }, [host.id])

      react.useEffect(() => {
        if (open && items === null) loadWorkspaces()
      }, [open, items, loadWorkspaces])

      const toggle = (workspaceId) => {
        const next = (items ?? []).map((item) =>
          item.workspaceId === workspaceId ? { ...item, visible: !item.visible } : item,
        )
        setItems(next)
        const visible = next.filter((item) => item.visible).map((item) => item.workspaceId)
        props.onInclude(host.id, visible, next.length).catch((e) => setError(String(e.message ?? e)))
      }

      const test = () => {
        setBusy(true)
        setNote(null)
        setError(null)
        api('/remote-workspaces/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host: host.id }),
        })
          .then((value) => setNote(`连接正常：${value.workspaces} 个工作区，${value.sessions} 个会话`))
          .catch((e) => setError(String(e.message ?? e)))
          .finally(() => setBusy(false))
      }

      const visibleCount = (items ?? []).filter((item) => item.visible).length

      return h(
        'div',
        { style: styles.card },
        h(
          'div',
          { style: styles.host },
          h(
            'div',
            { style: styles.hostTop },
            h('span', { style: styles.name }, host.label || host.id),
            h('span', { style: styles.status },
              h('span', { style: { ...styles.dot, background: host.hasToken || host.hasCookie ? '#4fbf7f' : '#6b6b6e' } }),
              host.hasCookie ? '使用浏览器 cookie' : host.hasToken ? '已配置' : '缺少凭据'),
            h('span', { style: styles.acts },
              h('button', { style: styles.button, onClick: test, disabled: busy }, '测试连接'),
              h('button', { style: styles.button, onClick: () => props.onEdit(host) }, '编辑'),
              h('button', { style: { ...styles.button, ...styles.buttonGhost }, onClick: () => props.onRemove(host) }, '移除'),
            ),
          ),
          h('div', { style: styles.kv }, h('span', { style: styles.key }, '地址'), h('span', { style: styles.mono }, host.baseUrl)),
          h('div', { style: styles.kv }, h('span', { style: styles.key }, '凭据'),
            h('span', { style: styles.mono },
              host.hasCookie ? '浏览器 cookie（自动续期）' : host.hasToken ? '••••••••••••••••' : '（未设置）')),
          note !== null ? h('div', { style: { ...styles.ok, padding: '10px 0 0' } }, note) : null,
          error !== null ? h('div', { style: { ...styles.error, padding: '10px 0 0' } }, error) : null,
        ),
        h(
          'div',
          { style: { ...styles.subhead, cursor: 'pointer' }, onClick: () => setOpen(!open) },
          h('span', null, '工作区'),
          h('span', { style: { opacity: 0.6 } },
            items === null ? '' : `（显示 ${visibleCount} / 共 ${items.length}）`),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 12 } },
            items === null ? null : h('span', {
              onClick: (event) => {
                event.stopPropagation()
                props.onInclude(host.id, items.map((item) => item.workspaceId), items.length)
                setItems(items.map((item) => ({ ...item, visible: true })))
              },
            }, '全选'),
            items === null ? null : h('span', {
              onClick: (event) => {
                event.stopPropagation()
                props.onInclude(host.id, [], items.length)
                setItems(items.map((item) => ({ ...item, visible: false })))
              },
            }, '全不选'),
            h('span', null, open ? '收起' : '展开')),
        ),
        open
          ? (items === null
              ? h('div', { style: { ...styles.wsRow, opacity: 0.5 } }, busy ? '加载中…' : '')
              : items.map((item) =>
                  h(
                    'div',
                    { key: item.workspaceId, style: styles.wsRow },
                    h('span', { onClick: () => toggle(item.workspaceId), style: { display: 'flex', cursor: 'pointer' } }, h(Check, { on: item.visible })),
                    h('span', { style: { cursor: 'pointer', opacity: item.visible ? 1 : 0.45 }, onClick: () => toggle(item.workspaceId) }, item.title),
                    h('span', { style: styles.wsPath }, item.path),
                    h('span', { style: styles.wsCount }, `${item.sessionCount} 个会话`),
                  ),
                ))
          : null,
      )
    }

    function HostForm(props) {
      const initial = props.host ?? { id: '', label: '', baseUrl: '', hasToken: false }
      const [id, setId] = react.useState(initial.id)
      const [label, setLabel] = react.useState(initial.label ?? '')
      const [baseUrl, setBaseUrl] = react.useState(initial.baseUrl ?? '')
      const [token, setToken] = react.useState('')

      const save = () => {
        props.onSave({
          id: id.trim() === '' ? label.trim() : id.trim(),
          label: label.trim(),
          baseUrl: baseUrl.trim(),
          token: token.trim(),
        })
      }

      return h(
        'div',
        { style: styles.form },
        h('div', { style: styles.field }, h('span', { style: styles.label }, '名称'), h('input', { style: styles.input, value: label, placeholder: '台式机', onChange: (e) => setLabel(e.target.value) })),
        h('div', { style: styles.field }, h('span', { style: styles.label }, '地址'), h('input', { style: styles.input, value: baseUrl, placeholder: 'http://127.0.0.1:52900', onChange: (e) => setBaseUrl(e.target.value) })),
        h('div', { style: styles.field }, h('span', { style: styles.label }, '令牌'), h('input', { style: styles.input, value: token, placeholder: initial.hasToken ? '留空则保持原令牌' : '远端启动时打印的 token', onChange: (e) => setToken(e.target.value) })),
        h('div', { style: { ...styles.field, gap: 8, justifyContent: 'flex-end' } },
          h('button', { style: styles.button, onClick: props.onCancel }, '取消'),
          h('button', { style: styles.button, onClick: save }, '保存')),
      )
    }

    function RemoteClientSection() {
      const [status, setStatus] = react.useState(null)
      const [config, setConfig] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [note, setNote] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [username, setUsername] = react.useState('')
      const [password, setPassword] = react.useState('')
      const [role, setRole] = react.useState('client')
      const [device, setDevice] = react.useState('desk')
      const [local, setLocal] = react.useState('auto')
      const [listen, setListen] = react.useState('127.0.0.1:52900')
      const [relay, setRelay] = react.useState('')
      const [fingerprint, setFingerprint] = react.useState('')
      const [autoStart, setAutoStart] = react.useState(false)
      const [cookieDb, setCookieDb] = react.useState('')
      const [endpointFile, setEndpointFile] = react.useState('')
      const [editing, setEditing] = react.useState(null)
      const [adding, setAdding] = react.useState(false)
      const [devices, setDevices] = react.useState([])
      const [viewers, setViewers] = react.useState([])

      const load = react.useCallback(() => {
        api('/relay/status')
          .then((value) => {
            setStatus(value)
            setRelay((current) => (current === '' ? value.relay ?? '' : current))
            setUsername((current) => (current === '' ? value.username ?? '' : current))
            setRole(value.role ?? 'client')
            setDevice(value.device ?? 'desk')
            setLocal(value.local ?? 'auto')
            setListen(value.listen ?? '127.0.0.1:52900')
            setAutoStart(value.autoStart === true)
            setCookieDb((current) => (current === '' ? value.cookieDb ?? '' : current))
            setEndpointFile((current) => (current === '' ? value.endpointFile ?? '' : current))
          })
          .catch((e) => setError(String(e.message ?? e)))
        api('/remote-workspaces/config')
          .then(setConfig)
          .catch((e) => setError(String(e.message ?? e)))
        api('/relay/devices')
          .then((value) => { setDevices(value.devices ?? []); setViewers(value.clients ?? []) })
          .catch(() => { setDevices([]); setViewers([]) })
      }, [])

      react.useEffect(load, [load])
      react.useEffect(() => {
        const timer = setInterval(load, 3000)
        return () => clearInterval(timer)
      }, [load])

      const post = (path, body) =>
        api(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })

      const run = react.useCallback(async (task, message) => {
        setBusy(true)
        setError(null)
        setNote(null)
        try {
          await task()
          if (message !== undefined) setNote(message)
          load()
        } catch (e) {
          setError(String(e.message ?? e))
        } finally {
          setBusy(false)
        }
      }, [load])

      const signedIn = status?.hasToken === true
      const running = status?.running === true
      const agentDown = status?.agentOnline === false

      const field = (label, value, onChange, props = {}) => {
        const { flex, ...inputProps } = props
        return h('label', { style: { ...styles.field, ...(flex === undefined ? {} : { flex }) } },
          h('span', { style: styles.fieldLabel }, label),
          h('input', { style: styles.input, value, onChange: (event) => onChange(event.target.value), ...inputProps }))
      }

      const saveRole = () => post('/relay/save', { relay, fingerprint, role, device, local, listen, autoStart, cookieDb, endpointFile })
      const restart = async () => {
        await saveRole()
        if (running) await post('/relay/stop')
        await post('/relay/start')
      }

      const hosts = config?.hosts ?? []
      const include = config?.include ?? {}
      const persist = (nextHosts, nextInclude) =>
        api('/remote-workspaces/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            hosts: nextHosts.map((host) => ({ id: host.id, label: host.label, baseUrl: host.baseUrl, token: host.token ?? '' })),
            include: nextInclude,
          }),
        }).then(load)

      const upsertHost = (host) => {
        const next = hosts.filter((item) => item.id !== host.id)
        next.push({ ...host, hasToken: host.token !== '' || (hosts.find((item) => item.id === host.id)?.hasToken ?? false) })
        setEditing(null)
        setAdding(false)
        persist(next, include).catch((e) => setError(String(e.message ?? e)))
      }

      const removeHost = (host) => {
        const next = hosts.filter((item) => item.id !== host.id)
        const nextInclude = { ...include }
        delete nextInclude[host.id]
        persist(next, nextInclude).catch((e) => setError(String(e.message ?? e)))
      }

      const setInclude = (hostId, visible, total) => {
        const next = { ...include }
        if (total !== undefined && visible.length === total) delete next[hostId]
        else next[hostId] = visible
        return persist(hosts, next)
      }

      return h('div', { style: styles.wrap },

        // 0. 关于：版本与联系方式，放在最顶部方便复制/反馈
        h('div', { style: styles.card },
          h('div', { style: styles.about },
            h('div', { style: styles.aboutTop },
              h('span', { style: styles.aboutTitle }, PROJECT.name),
              h('span', { style: styles.versionChip }, `v${status?.version ?? '…'}`)),
            h('div', { style: styles.aboutLinks },
              h('a', {
                style: styles.aboutItem,
                href: PROJECT.repo,
                target: '_blank',
                rel: 'noreferrer',
                title: PROJECT.repo,
                onClick: (event) => { event.preventDefault(); window.open(PROJECT.repo, '_blank', 'noopener') },
              }, h(IconGithub, { size: 15 }), h('span', null, 'GitHub')),
              h('a', { style: styles.aboutItem, href: `mailto:${PROJECT.mail}`, title: `邮件联系 ${PROJECT.mail}` },
                h(IconMail, { size: 15 }), h('span', null, PROJECT.mail)),
              h('span', { style: styles.aboutItem, title: `${PROJECT.qqName} ${PROJECT.qq}` },
                h(IconChat, { size: 15 }), h('span', null, `${PROJECT.qqName} ${PROJECT.qq}`)),
            )),
        ),

        // 1. 账号
        h('div', { style: styles.card },
          h('div', { style: styles.headRow },
            h('span', { style: styles.cardTitle }, '账号'),
            h('span', { style: { marginLeft: 'auto', ...styles.status } },
              h('span', { style: { ...styles.dot, background: signedIn ? '#34d399' : 'rgba(255,255,255,.25)' } }),
              signedIn ? `已登录 ${status?.username ?? ''}` : '未登录')),
          h('div', { style: styles.host },
            signedIn
              ? h('div', { style: { ...styles.hint, paddingBottom: 10 } }, `当前账号：${status?.username ?? ''}`)
              : null,
            h('div', { style: styles.row },
              field('用户名', username, setUsername, { disabled: signedIn }),
              field('密码', password, setPassword, { type: 'password', disabled: signedIn })),
            h('div', { style: styles.row },
              h('button', { style: styles.button, disabled: busy || signedIn, onClick: () => run(() => post('/relay/register', { relay, fingerprint, username, password }).then(() => setPassword('')), '注册成功') }, '注册'),
              h('button', { style: styles.button, disabled: busy || signedIn, onClick: () => run(() => post('/relay/login', { relay, fingerprint, username, password }).then(() => setPassword('')), '登录成功') }, '登录'),
              h('button', { style: styles.button, disabled: busy || !signedIn, onClick: () => run(() => post('/relay/logout'), '已退出登录') }, '退出'),
              signedIn ? null : h('span', { style: { ...styles.hint, alignSelf: 'center' } }, '两端用同一个账号登录'))),
          ),

        // 2. 这台机器
        h('div', { style: styles.card },
          h('div', { style: styles.headRow },
            h('span', { style: styles.cardTitle }, '这台机器'),
            h('span', { style: { marginLeft: 'auto', ...styles.status } },
              h('span', { style: { ...styles.dot, background: running ? (agentDown ? '#f59e0b' : '#34d399') : 'rgba(255,255,255,.25)' } }),
              running ? (agentDown ? '等待对端' : '已连接') : '未运行')),
          h('div', { style: styles.host },
            h('div', { style: styles.row },
              h('label', { style: styles.radio },
                h('input', { type: 'radio', checked: role === 'agent', onChange: () => setRole('agent') }),
                h('span', null, '远程端（这台跑 DSH）')),
              h('label', { style: styles.radio },
                h('input', { type: 'radio', checked: role === 'client', onChange: () => setRole('client') }),
                h('span', null, '本地端（我在这台查看）'))),
            h('div', { style: styles.row },
              field('设备名', device, setDevice, { placeholder: 'desk', flex: '0 0 160px' }),
              role === 'agent'
                ? field('DSH 地址', local, setLocal, { placeholder: 'auto' })
                : field('本机端口', listen, setListen, { placeholder: '127.0.0.1:52900' })),
            h('div', { style: styles.row },
              h('button', {
                style: styles.button,
                disabled: busy || !signedIn,
                onClick: () => run(restart, '已保存并启动'),
              }, running ? '保存并重启' : '保存并启动'),
              h('button', {
                style: styles.button,
                disabled: busy || !running,
                onClick: () => run(() => post('/relay/stop'), '已停止'),
              }, '停止'))),
          ),

        // 2.5 账号下的设备：远程端 / 本地端 两段，每行两行文字 + 右侧操作
        signedIn ? h('div', { style: styles.card },
          h('div', { style: styles.headRow },
            h('span', { style: styles.cardTitle }, '账号下的设备'),
            h('span', { style: { marginLeft: 'auto', ...styles.countChip } }, `${devices.length + viewers.length} 台`)),
          h('div', { style: styles.deviceList },

            h('div', { style: styles.groupLabel }, '远程端'),
            devices.length === 0
              ? h('div', { style: styles.emptyHint }, '还没有远程端。在另一台机器上登录同一账号、选「远程端」并启动。')
              : devices.map((item) => {
                  const tunnel = (status?.tunnels ?? []).find((entry) => entry.id === `device-${item.device}`)
                  const linked = tunnel?.running === true
                  const own = item.device === device
                  const meta = own
                    ? (running ? `本机正在配对${item.online ? ' · 在线' : ' · 对方离线'}` : '本机配对的设备名 · 未启动')
                    : (linked ? `已连接 ${String(tunnel.listen).replace('127.0.0.1:', ':')}` : item.online ? '在线 · 未连接' : '离线')
                  const action = own
                    ? h('span', { style: styles.rowNote }, '在「这台机器」里管理')
                    : role !== 'client'
                      ? h('span', { style: styles.rowNote }, '仅本地端可连接')
                      : h('button', {
                          style: linked ? { ...styles.button, ...styles.buttonQuiet } : styles.button,
                          disabled: busy,
                          onClick: () => run(
                            () => (linked
                              ? post('/relay/tunnel/stop', { id: tunnel.id })
                              : post('/relay/tunnel/start', { device: item.device })),
                            linked ? `已断开 ${item.device}` : `已连接 ${item.device}，可在下方勾选工作区`,
                          ),
                        }, linked ? '断开' : '连接')
                  return h('div', { key: `remote-${item.device}`, style: styles.deviceRow },
                    h('span', { style: { ...styles.deviceAvatar, opacity: item.online ? 1 : 0.5 } }, h(IconMonitor, null)),
                    h('span', { style: styles.deviceBody },
                      h('span', { style: styles.deviceNameLine },
                        h('span', { style: styles.deviceName }, item.device),
                        own ? h('span', { style: styles.badgeNeutral }, '当前配对') : null),
                      h('span', { style: styles.deviceMeta }, meta)),
                    action,
                  )
                }),

            h('div', { style: styles.groupLabel }, '本地端'),
            h('div', { style: styles.deviceRow },
              h('span', { style: styles.deviceAvatar }, h(IconLaptop, null)),
              h('span', { style: styles.deviceBody },
                h('span', { style: styles.deviceNameLine },
                  h('span', { style: styles.deviceName }, status?.hostname ?? '本机'),
                  h('span', { style: styles.badgeOn }, '本机')),
                h('span', { style: styles.deviceMeta }, running ? `正在查看 ${device}` : '未连接')),
              h('span', { style: styles.rowNote }, '当前窗口')),
            viewers.length === 0
              ? h('div', { style: styles.emptyHint }, '没有其他本地端在查看这个账号。')
              : viewers.map((item) => h('div', { key: `client-${item.clientId}`, style: styles.deviceRow },
                  h('span', { style: { ...styles.deviceAvatar, opacity: item.online ? 1 : 0.5 } }, h(IconLaptop, null)),
                  h('span', { style: styles.deviceBody },
                    h('span', { style: styles.deviceNameLine },
                      h('span', { style: styles.deviceName }, item.hostname || item.clientId),
                      item.online ? h('span', { style: styles.badgeOn }, '在线') : null),
                    h('span', { style: styles.deviceMeta },
                      `${item.watching === '' ? '未指定设备' : `正在查看 ${item.watching}`}${item.online ? '' : ' · 离线'}`)),
                )),

            devices.length === 1
              ? h('div', { style: styles.footNote },
                  '两台机器用同一个设备名时，relay 会当成同一台。要分别看到，请给它们起不同的名字（例如 desk / laptop）。')
              : null,
          ),
        ) : null,

        // 3. 远程主机与工作区
        h('div', { style: styles.card },
          h('div', { style: styles.headRow },
            h('span', { style: styles.cardTitle }, '远程主机与工作区'),
            h('span', { style: { marginLeft: 'auto' } },
              h('button', { style: styles.button, onClick: () => { setAdding(true); setEditing(null) } }, '添加主机'))),
          hosts.length === 0
            ? h('div', { style: { ...styles.hint, padding: '0 20px 16px' } }, '还没有远程主机。先在上面登录并启动，隧道会自动写入一条。')
            : null,
          hosts.map((host) =>
            editing !== null && editing.id === host.id
              ? h(HostForm, { key: host.id, host: editing, onCancel: () => setEditing(null), onSave: upsertHost })
              : h(HostCard, {
                  key: host.id,
                  host,
                  onEdit: (target) => setEditing({ ...target, token: '' }),
                  onRemove: removeHost,
                  onInclude: setInclude,
                })),
          adding ? h(HostForm, { onCancel: () => setAdding(false), onSave: upsertHost }) : null,
          ),

        error === null ? null : h('div', { style: styles.error }, error),
        note === null ? null : h('div', { style: styles.ok }, note),

        // 其余全部折叠
        h('details', { style: styles.details },
          h('summary', { style: styles.summary }, '高级设置'),
          h('div', { style: styles.host },
            h('div', { style: styles.row },
              field('中转地址', relay, setRelay, { placeholder: '1.2.3.4:19090' }),
              field('证书指纹', fingerprint, setFingerprint, { placeholder: '可选' })),
            h('div', { style: styles.row },
              h('label', { style: styles.radio },
                h('input', { type: 'checkbox', checked: autoStart, onChange: (event) => setAutoStart(event.target.checked) }),
                h('span', null, 'DSH 启动时自动运行隧道'))),
            role === 'agent'
              ? h('div', { style: styles.row },
                  field('cookie 库路径', cookieDb, setCookieDb, { placeholder: '留空使用默认' }),
                  field('endpoint 文件', endpointFile, setEndpointFile, { placeholder: '优先于 cookie 库' }))
              : null,
            h('div', { style: styles.row },
              h('button', { style: styles.button, disabled: busy || !signedIn, onClick: () => run(saveRole, '已保存') }, '仅保存配置'))),
          status === null || status.log === undefined || status.log.length === 0
            ? null
            : h('pre', { style: styles.log }, status.log.slice(-10).join('\n')),
          h('div', { style: styles.foot }, config?.source === undefined ? '' : `配置文件：${config.source}`)),
      )
    }

    /**
     * The desktop app serves its renderer from `dsh-app://`, where the bundled upload
     * worker's XMLHttpRequest does not reach the Host. Every other call in the app goes
     * through fetch, so route uploads through fetch as well: this replaces the service's
     * background carrier, which is exactly the seat `__DSH_FILE_UPLOAD__` would fill.
     */
    function probe(stage, detail) {
      try {
        fetch('/remote-workspaces/client-probe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stage, detail: detail === undefined ? undefined : String(detail).slice(0, 200) }),
        }).catch(() => {})
      } catch {
        // Diagnostics only; never disturb the shell.
      }
    }

    /** Page-context XHR fallback: a different carrier than both fetch and the worker. */
    function xhrPost(request) {
      return new Promise((resolve, reject) => {
        try {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', request.path)
          xhr.withCredentials = true
          for (const [name, value] of Object.entries(request.headers ?? {})) xhr.setRequestHeader(name, value)
          if (request.onProgress !== undefined) {
            xhr.upload.onprogress = (event) => request.onProgress({ loaded: event.loaded, ...(event.lengthComputable ? { total: event.total } : {}) })
          }
          xhr.onload = () => {
            probe('xhr-done', `${xhr.status}`)
            resolve({ status: xhr.status, body: xhr.responseText })
          }
          xhr.onerror = () => {
            probe('xhr-failed', 'network')
            reject(new Error('background upload transport failed'))
          }
          xhr.send(request.body)
        } catch (error) {
          probe('xhr-throw', String(error && error.message))
          reject(error)
        }
      })
    }

    function installFetchUploadTransport(ctx) {
      // Never touch ctx.<service> here: cordis throws for properties that are not
      // declared in `inject`, and that throw used to abort the whole install.
      probe('apply', `inject=${typeof ctx.inject}`)
      try {
        const boot = window.__DSH_BOOT__ ?? {}
        const interesting = Object.fromEntries(Object.entries(boot).filter(([key, value]) => /url|origin|host|base|api/i.test(key) && typeof value === 'string'))
        probe('env', JSON.stringify({ origin: location.origin, baseUri: document.baseURI, bootKeys: Object.keys(boot).slice(0, 12), interesting }).slice(0, 360))
      } catch (error) {
        probe('env-failed', String(error && error.message))
      }
      const swap = (runtime, how) => {
        if (runtime === undefined || runtime.transport === undefined) {
          probe('no-runtime', how)
          return false
        }
        const transport = {
          async post(request) {
            probe('post', `${request.path} body=${request.body instanceof Blob ? 'blob' : typeof request.body}`)
            const init = {
              method: 'POST',
              ...(request.headers === undefined ? {} : { headers: request.headers }),
              body: request.body,
              ...(request.body instanceof ReadableStream ? { duplex: 'half' } : {}),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            }
            try {
              const response = await fetch(request.path, init)
              const text = await response.text()
              probe('post-done', `${response.status} ${text.slice(0, 60)}`)
              return { status: response.status, body: text }
            } catch (error) {
              // A cancelled upload must not be retried: the caller already discarded the
              // draft, so a second carrier only wastes the bytes and hides the cancel.
              if (request.signal?.aborted === true) {
                probe('post-aborted', (error && error.message) || error)
                throw error
              }
              // A custom-scheme fetch can reject for one request while the next one
              // succeeds; retry through the page's XHR carrier before giving up.
              probe('post-failed', (error && error.message) || error)
              return await xhrPost(request)
            }
          },
        }
        runtime.transport = transport
        probe('installed', how)
        console.log('[remote-workspaces] upload transport switched to fetch')
        return true
      }
      // `ctx.inject` is the only seat that may read the service; it fires when the
      // upload runtime exists, which can be later than this plugin's apply.
      if (typeof ctx.inject !== 'function') return probe('no-inject-seat')
      ctx.inject(['fileUpload'], (inner) => {
        const runtime = inner.fileUpload
        if (swap(runtime, 'inject')) routeSmallUploadsThroughTransport(runtime)
      })
    }

    /**
     * The runtime sends a `Uint8Array` body through the agent-scoped
     * `fileUploads/upload` RPC, which the local gateway cannot resolve for a Session
     * that lives on another Host — the upload dies as "session/not-found" before any
     * forwarding. Small bodies therefore go through the same HTTP route as large ones.
     */
    function routeSmallUploadsThroughTransport(runtime) {
      if (typeof runtime.upload !== 'function') return probe('no-upload-method')
      if (runtime.upload.__remoteWorkspacesShim === true) return
      const original = runtime.upload.bind(runtime)
      const wrapper = async (sessionId, data, name, signal, onProgress) => {
        if (!(data instanceof Uint8Array)) return original(sessionId, data, name, signal, onProgress)
        probe('upload-array', `${data.length}B`)
        const query = new URLSearchParams({ sessionId })
        if (name !== undefined) query.set('name', name)
        const response = await runtime.transport.post({
          path: `/api/session/uploadFileBinary?${query.toString()}`,
          body: new Blob([data], { type: 'application/octet-stream' }),
          headers: { 'content-type': 'application/octet-stream' },
          ...(signal === undefined ? {} : { signal }),
          ...(onProgress === undefined ? {} : { onProgress }),
        })
        if (response.status !== 200) throw new Error(`file upload transport failed with HTTP ${String(response.status)}`)
        const parsed = JSON.parse(response.body)
        if (parsed?.ok === true) return { ok: true, value: parsed.value }
        const error = parsed?.error ?? {}
        const failure = new Error(error.message ?? 'upload failed')
        failure.code = error.code
        failure.details = error.details
        return { ok: false, error: failure }
      }
      wrapper.__remoteWorkspacesShim = true
      runtime.upload = wrapper
      probe('upload-routed', 'transport')
      if (typeof runtime.post === 'function' && runtime.post.__remoteWorkspacesShim !== true) {
        const originalPost = runtime.post.bind(runtime)
        const postWrapper = (request) => {
          probe('runtime-post', request && request.path)
          return originalPost(request)
        }
        postWrapper.__remoteWorkspacesShim = true
        runtime.post = postWrapper
      }
    }

    function apply(ctx) {
      try {
        if (ctx.slots === undefined || typeof ctx.slots.inject !== 'function') {
          throw new Error(`ctx.slots unavailable; ctx keys = ${Object.keys(ctx).join(',')}`)
        }
        try {
          installFetchUploadTransport(ctx)
        } catch (error) {
          probe('install-failed', (error && error.message) || error)
        }
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 4,
              label: () => 'DSH远程客户端',
            },
            RemoteClientSection,
          ),
        )
      } catch (error) {
        // A failing settings section must never take the whole shell down.
        console.error('[remote-workspaces] apply failed:', (error && error.stack) || error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})

// hmr-nudge 1794708070
