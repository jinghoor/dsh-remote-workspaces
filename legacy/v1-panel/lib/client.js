window.__ModuleLoader__.load({
  id: 'dsh-remote-sessions',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var react = require('react')
    var h = react.createElement

    var PANEL_ID = 'remote-sessions'

    var styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        fontSize: 13,
        color: 'var(--dsh-text-primary, #e6e6e6)',
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsh-border-subtle, rgba(255,255,255,0.08))',
        flex: '0 0 auto',
      },
      select: {
        background: 'transparent',
        color: 'inherit',
        border: '1px solid var(--dsh-border-subtle, rgba(255,255,255,0.15))',
        borderRadius: 6,
        padding: '3px 6px',
        fontSize: 12,
      },
      button: {
        background: 'transparent',
        color: 'inherit',
        border: '1px solid var(--dsh-border-subtle, rgba(255,255,255,0.15))',
        borderRadius: 6,
        padding: '3px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      list: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, padding: '6px 8px' },
      row: {
        padding: '8px 10px',
        borderRadius: 8,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      },
      title: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: 11, opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      empty: { padding: 20, opacity: 0.55, fontSize: 12, textAlign: 'center' },
      error: { padding: '10px 14px', color: '#f87171', fontSize: 12, whiteSpace: 'pre-wrap' },
      transcript: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 12 },
      bubbleUser: { alignSelf: 'flex-end', maxWidth: '85%', padding: '8px 11px', borderRadius: 10, background: 'var(--dsh-surface-raised, rgba(255,255,255,0.08))', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      bubbleAssistant: { alignSelf: 'flex-start', maxWidth: '92%', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55 },
      toolLine: { fontSize: 11, opacity: 0.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', borderLeft: '2px solid rgba(255,255,255,0.12)', paddingLeft: 8 },
      composer: {
        flex: '0 0 auto',
        display: 'flex',
        gap: 8,
        padding: '10px 14px',
        borderTop: '1px solid var(--dsh-border-subtle, rgba(255,255,255,0.08))',
      },
      textarea: {
        flex: '1 1 auto',
        resize: 'none',
        height: 54,
        background: 'transparent',
        color: 'inherit',
        border: '1px solid var(--dsh-border-subtle, rgba(255,255,255,0.15))',
        borderRadius: 8,
        padding: '6px 9px',
        fontSize: 13,
        fontFamily: 'inherit',
      },
    }

    function RemoteIcon() {
      return h(
        'svg',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M3 12h18' }),
        h('path', { d: 'M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18' }),
      )
    }

    async function requestJson(url, init) {
      const res = await fetch(url, { credentials: 'same-origin', ...(init ?? {}) })
      const body = await res.json().catch(() => null)
      if (!res.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${res.status}`)
      return body.value
    }

    function rpc(hostId, endpoint, args) {
      return requestJson('/remote-dsh/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: hostId, endpoint, args }),
      })
    }

    function formatTime(ms) {
      if (typeof ms !== 'number') return ''
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function rowLabel(item) {
      const title = item?.projections?.values?.title
      if (typeof title === 'string' && title.trim() !== '') return title
      const outline = item?.projections?.values?.turnOutline
      if (Array.isArray(outline) && outline.length > 0 && typeof outline[0]?.prompt === 'string') {
        return outline[0].prompt.slice(0, 80)
      }
      return item?.sessionId ?? '(unnamed)'
    }

    /**
     * A session's workspace is its working directory; the row carries it twice
     * (`cwd` cold, `projections.values.workingDirectory` warm) and either may be absent.
     */
    function workspaceOf(item) {
      const cwd = item?.cwd ?? item?.projections?.values?.workingDirectory
      return typeof cwd === 'string' && cwd !== '' ? cwd : null
    }

    function workspaceLabel(cwd, clashing) {
      const parts = cwd.split('/').filter((part) => part !== '')
      if (parts.length === 0) return cwd
      const leaf = parts[parts.length - 1]
      // 侧栏很窄：默认只给目录名，只有两个工作区重名时才带上父目录。
      return clashing.has(leaf) && parts.length > 1 ? `…/${parts.slice(-2).join('/')}` : leaf
    }

    /**
     * 远端返回它能看到的所有会话，工作区分组只能在这边做：
     * `session/list` 的 descriptor 只有 cursor，没有工作区过滤参数。
     */
    function groupWorkspaces(sessions) {
      const counts = new Map()
      for (const item of sessions) {
        const cwd = workspaceOf(item)
        if (cwd === null) continue
        counts.set(cwd, (counts.get(cwd) ?? 0) + 1)
      }
      // 重名按「工作区个数」判定，不是「会话条数」——否则同一目录的多条会话会自我误判。
      const perLeaf = new Map()
      for (const cwd of counts.keys()) {
        const leaf = workspaceLabel(cwd, new Set())
        perLeaf.set(leaf, (perLeaf.get(leaf) ?? 0) + 1)
      }
      const clashing = new Set([...perLeaf].filter(([, count]) => count > 1).map(([leaf]) => leaf))
      return [...counts]
        .map(([cwd, count]) => ({ cwd, count, label: workspaceLabel(cwd, clashing) }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    }

    function textOfContent(content) {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .filter((part) => part != null && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    }

    function renderEvent(event, index) {
      const type = event?.type
      const data = event?.data ?? {}
      if (type === 'user/rpc' || type === 'user/message') {
        const text = textOfContent(data.content ?? data.message?.content)
        if (text.trim() === '') return null
        return h('div', { key: index, style: styles.bubbleUser }, text)
      }
      if (type === 'assistant/message') {
        const text = textOfContent(data.message?.content)
        if (text.trim() === '') return null
        return h('div', { key: index, style: styles.bubbleAssistant }, text)
      }
      if (type === 'tool/call') {
        const name = typeof data.name === 'string' ? data.name : 'tool'
        const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
        return h('div', { key: index, style: styles.toolLine }, `→ ${name} ${args.slice(0, 220)}`)
      }
      if (type === 'tool/result') {
        return h('div', { key: index, style: styles.toolLine }, '← result')
      }
      return null
    }

    function SessionDetail(props) {
      const [records, setRecords] = react.useState([])
      const [error, setError] = react.useState(null)
      const [loading, setLoading] = react.useState(true)
      const [draft, setDraft] = react.useState('')
      const [sending, setSending] = react.useState(false)
      const scrollRef = react.useRef(null)

      const load = react.useCallback(() => {
        let alive = true
        setLoading(true)
        setError(null)
        const url = `/remote-dsh/history?host=${encodeURIComponent(props.hostId)}&sessionId=${encodeURIComponent(props.sessionId)}&throughSeq=${Number(props.throughSeq) || 0}&maxMessages=120`
        requestJson(url)
          .then((value) => {
            if (!alive) return
            setRecords(Array.isArray(value?.records) ? value.records : [])
          })
          .catch((e) => alive && setError(String(e.message ?? e)))
          .finally(() => alive && setLoading(false))
        return () => {
          alive = false
        }
      }, [props.hostId, props.sessionId, props.throughSeq])

      react.useEffect(() => load(), [load])

      react.useEffect(() => {
        const node = scrollRef.current
        if (node != null) node.scrollTop = node.scrollHeight
      }, [records])

      const send = react.useCallback(() => {
        const text = draft.trim()
        if (text === '' || sending) return
        setSending(true)
        setError(null)
        rpc(props.hostId, 'session/prompt', {
          request: {
            requestId: `rs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
            sessionId: props.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
            clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        })
          .then(() => {
            setDraft('')
            setTimeout(load, 700)
          })
          .catch((e) => setError(String(e.message ?? e)))
          .finally(() => setSending(false))
      }, [draft, sending, props.hostId, props.sessionId, load])

      const nodes = []
      for (let i = 0; i < records.length; i++) {
        const node = renderEvent(records[i].event, i)
        if (node !== null) nodes.push(node)
      }

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.bar },
          h('button', { style: styles.button, onClick: props.onBack }, '← 返回'),
          h('span', { style: styles.title }, rowLabel(props.session)),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', { style: styles.button, onClick: load }, '重载'),
        ),
        error !== null ? h('div', { style: styles.error }, error) : null,
        loading && nodes.length === 0 ? h('div', { style: styles.empty }, '加载历史…') : null,
        h('div', { ref: scrollRef, style: styles.transcript }, nodes),
        h(
          'div',
          { style: styles.composer },
          h('textarea', {
            style: styles.textarea,
            value: draft,
            placeholder: sending ? '发送中…' : '发消息到远端会话（实际执行在远端机器）',
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                send()
              }
            },
          }),
          h('button', { style: styles.button, onClick: send, disabled: sending }, sending ? '…' : '发送'),
        ),
      )
    }

    function RemotePage() {
      const [hosts, setHosts] = react.useState([])
      const [hostId, setHostId] = react.useState(null)
      const [sessions, setSessions] = react.useState([])
      const [selected, setSelected] = react.useState(null)
      const [error, setError] = react.useState(null)
      const [loading, setLoading] = react.useState(false)
      const [workspace, setWorkspace] = react.useState('*')

      react.useEffect(() => {
        let alive = true
        requestJson('/remote-dsh/hosts')
          .then((list) => {
            if (!alive) return
            setHosts(list)
            if (list.length > 0) setHostId((current) => current ?? list[0].id)
          })
          .catch((e) => alive && setError(String(e.message ?? e)))
        return () => {
          alive = false
        }
      }, [])

      const reload = react.useCallback(
        (id) => {
          if (!id) return
          setLoading(true)
          setError(null)
          requestJson(`/remote-dsh/sessions?host=${encodeURIComponent(id)}`)
            .then((value) => setSessions(Array.isArray(value?.items) ? value.items : []))
            .catch((e) => setError(String(e.message ?? e)))
            .finally(() => setLoading(false))
        },
        [],
      )

      react.useEffect(() => {
        reload(hostId)
      }, [hostId, reload])

      const workspaces = react.useMemo(() => groupWorkspaces(sessions), [sessions])

      react.useEffect(() => {
        if (workspace !== '*' && !workspaces.some((row) => row.cwd === workspace)) setWorkspace('*')
      }, [workspaces, workspace])

      const visible = workspace === '*' ? sessions : sessions.filter((item) => workspaceOf(item) === workspace)

      if (selected !== null) {
        return h(SessionDetail, {
          hostId,
          sessionId: selected.sessionId,
          session: selected,
          throughSeq: selected?.projections?.asOfSeq ?? 0,
          onBack: () => setSelected(null),
        })
      }

      const rows = visible.map((item) =>
        h(
          'div',
          {
            key: item.sessionId,
            style: styles.row,
            title: item.sessionId,
            onClick: () => setSelected(item),
            onMouseEnter: (e) => {
              e.currentTarget.style.background = 'var(--dsh-surface-hover, rgba(255,255,255,0.05))'
            },
            onMouseLeave: (e) => {
              e.currentTarget.style.background = 'transparent'
            },
          },
          h('div', { style: styles.title }, rowLabel(item)),
          h(
            'div',
            { style: styles.meta },
            [
              item.running === true ? '● 运行中' : null,
              formatTime(item.updatedAt),
              typeof item.cwd === 'string' ? item.cwd : null,
            ]
              .filter((part) => part !== null && part !== '')
              .join(' · '),
          ),
        ),
      )

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.bar },
          h('span', { style: { fontWeight: 600 } }, '远程会话'),
          hosts.length > 1
            ? h(
                'select',
                {
                  style: styles.select,
                  value: hostId ?? '',
                  onChange: (e) => setHostId(e.target.value),
                },
                hosts.map((host) => h('option', { key: host.id, value: host.id }, host.label || host.id)),
              )
            : null,
          workspaces.length > 1
            ? h(
                'select',
                {
                  style: { ...styles.select, maxWidth: 190 },
                  value: workspace,
                  title: workspace === '*' ? '全部工作区' : workspace,
                  onChange: (e) => setWorkspace(e.target.value),
                },
                h('option', { value: '*' }, `全部工作区 (${sessions.length})`),
                workspaces.map((row) =>
                  h('option', { key: row.cwd, value: row.cwd, title: row.cwd }, `${row.label} (${row.count})`),
                ),
              )
            : null,
          h('span', { style: { flex: '1 1 auto' } }),
          loading ? h('span', { style: styles.meta }, '加载中…') : null,
          h('button', { style: styles.button, onClick: () => reload(hostId) }, '刷新'),
        ),
        error !== null ? h('div', { style: styles.error }, error) : null,
        hosts.length === 0 && error === null ? h('div', { style: styles.empty }, '还没有配置远端 Host。') : null,
        hosts.length > 0 && rows.length === 0 && error === null && !loading
          ? h(
              'div',
              { style: styles.empty },
              sessions.length > 0 ? '该工作区没有会话。' : '远端没有会话。',
            )
          : null,
        h('div', { style: styles.list }, rows),
      )
    }

    function apply(ctx) {
      try {
        if (ctx.slots === undefined || typeof ctx.slots.inject !== 'function') {
          throw new Error(`ctx.slots unavailable; ctx keys = ${Object.keys(ctx).join(',')}`)
        }
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: () => '远程',
            },
            RemoteIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
            },
            RemotePage,
          ),
        )
      } catch (error) {
        // A failing panel must never take the whole web shell down: swallow after
        // reporting, so the session UI still boots with the panel simply missing.
        console.error('[remote-sessions] apply failed:', (error && error.stack) || error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
