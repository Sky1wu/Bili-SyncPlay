const STORAGE_KEY = "bili-syncplay-admin-token"
const AUTO_REFRESH_MS = 15000

const state = {
  token: localStorage.getItem(STORAGE_KEY) || "",
  me: null,
  currentRoute: "/overview",
  notice: null,
  dialog: null,
  refreshHandle: null,
  lastOverviewData: null,
  instanceId: "",
  overviewAutoRefresh: true
}

let dialogEventsBound = false

const routeMeta = {
  "/overview": { title: "概览", description: "服务、存储、运行态与近期事件的快速视图。" },
  "/rooms": { title: "房间管理", description: "筛选房间、查看详情并执行治理动作。" },
  "/events": { title: "运行事件", description: "按条件检索近期运行事件。" },
  "/audit-logs": { title: "审计日志", description: "查看管理员操作留痕和请求参数。" },
  "/config": { title: "配置摘要", description: "核对当前实例运行配置，不暴露敏感信息。" }
}

const appRoot = document.querySelector("#app")

async function bootstrap() {
  bindDialogEvents()
  state.currentRoute = normalizePath(location.pathname)

  if (state.token) {
    try {
      state.me = await api.getMe()
    } catch (error) {
      if (error.code !== "unauthorized") {
        showNotice("error", error.message || "管理员身份校验失败。")
      }
      clearAuth()
    }
  }

  if (!state.token && state.currentRoute !== "/login") {
    navigate("/login", true)
    return
  }

  if (state.token && state.currentRoute === "/login") {
    navigate("/overview", true)
    return
  }

  await render()
}

function normalizePath(pathname) {
  if (!pathname.startsWith("/admin")) {
    return "/login"
  }

  const path = pathname.slice("/admin".length) || "/overview"
  if (path === "/") {
    return state.token ? "/overview" : "/login"
  }
  return path
}

function routeHref(path) {
  return `/admin${path}`
}

function canManage() {
  return state.me && (state.me.role === "operator" || state.me.role === "admin")
}

function clearRefreshTimer() {
  if (state.refreshHandle) {
    clearInterval(state.refreshHandle)
    state.refreshHandle = null
  }
}

function clearAuth() {
  state.token = ""
  state.me = null
  localStorage.removeItem(STORAGE_KEY)
  clearRefreshTimer()
}

function showNotice(type, message) {
  state.notice = { type, message }
}

function clearNotice() {
  state.notice = null
}

function setToken(token) {
  state.token = token
  localStorage.setItem(STORAGE_KEY, token)
}

function navigate(path, replace = false) {
  state.currentRoute = path
  const method = replace ? history.replaceState : history.pushState
  method.call(history, null, "", routeHref(path))
  render().catch(handleFatalRenderError)
}

function navigateToUrl(url, path, replace = false) {
  state.currentRoute = path
  const method = replace ? history.replaceState : history.pushState
  method.call(history, null, "", url)
  render().catch(handleFatalRenderError)
}

function formatDateTime(value) {
  if (value === null || value === undefined || value === "") {
    return "—"
  }

  const date = typeof value === "number" ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "—"
  }

  const raw = typeof value === "number" ? String(value) : date.toISOString()
  return `<span title="${escapeHtml(raw)}">${escapeHtml(date.toLocaleString())}</span>`
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—"
  }

  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join(":")
}

function formatPlayback(playback) {
  if (!playback) {
    return "未同步"
  }

  const status = playback.paused ? "paused" : "playing"
  return `${status} @ ${Number(playback.currentTime ?? 0).toFixed(1)}s x${Number(playback.playbackRate ?? 1).toFixed(2)}`
}

function formatJson(value) {
  return escapeHtml(JSON.stringify(value, null, 2))
}

function renderEmptyValue(value = "—") {
  return `<span class="empty-value">${escapeHtml(value)}</span>`
}

function renderResultBadge(value) {
  const normalized = String(value || "").toLowerCase()
  let tone = "neutral"
  if (normalized === "ok" || normalized === "success" || normalized === "ready" || normalized === "healthy") {
    tone = "success"
  } else if (normalized === "rejected" || normalized === "error" || normalized === "failed" || normalized === "closed") {
    tone = "danger"
  } else if (normalized) {
    tone = "warning"
  }

  return `<span class="status ${tone}">${escapeHtml(value || "—")}</span>`
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function serializeQuery(query) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue
    }
    params.set(key, String(value))
  }

  const raw = params.toString()
  return raw ? `?${raw}` : ""
}

async function withAction(action, successMessage) {
  try {
    const result = await action()
    if (successMessage) {
      showNotice("success", successMessage)
    }
    await render()
    return result
  } catch (error) {
    showNotice("error", error.message || "操作失败。")
    render().catch(handleFatalRenderError)
    return null
  }
}

async function openReasonDialog(config) {
  return new Promise((resolve) => {
    state.dialog = {
      ...config,
      resolve
    }
    render().catch(handleFatalRenderError)
  })
}

function syncDialogDom() {
  const dialogRoot = document.querySelector(".dialog-root")
  if (!dialogRoot) {
    return
  }

  if (!state.dialog) {
    dialogRoot.hidden = true
    dialogRoot.replaceChildren()
    return
  }

  dialogRoot.outerHTML = renderDialog()
}

function closeDialog(result = null) {
  const resolver = state.dialog?.resolve
  state.dialog = null
  syncDialogDom()
  if (resolver) {
    resolver(result)
  }
  render().catch(handleFatalRenderError)
}

function bindDialogEvents() {
  if (dialogEventsBound) {
    return
  }

  dialogEventsBound = true

  document.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-dialog-close]")
    if (!closeButton) {
      return
    }

    event.preventDefault()
    closeDialog(null)
  })

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("#confirm-dialog")
    if (!form) {
      return
    }

    event.preventDefault()
    const reason = new FormData(form).get("reason")?.toString().trim() || ""
    closeDialog({ reason })
  })
}

async function confirmAction(config) {
  const result = await openReasonDialog(config)
  if (!result) {
    return
  }
  await withAction(() => config.onConfirm(result.reason), config.successMessage)
}

function handleFatalRenderError(error) {
  console.error(error)
  showNotice("error", "页面渲染失败。")
  appRoot.innerHTML = `<div class="login-shell"><div class="login-card"><h1>渲染失败</h1><p>${escapeHtml(error.message || "未知错误")}</p></div></div>`
}

async function render() {
  clearRefreshTimer()

  if (!state.token || state.currentRoute === "/login") {
    renderLogin()
    bindLoginEvents()
    return
  }

  const page = await loadPage()
  if (page.instanceId) {
    state.instanceId = page.instanceId
  }
  if (!page.instanceId && !state.instanceId) {
    await ensureInstanceId()
  }
  const meta = page.meta || routeMeta[state.currentRoute] || routeMeta["/overview"]
  const instanceId = page.instanceId || state.instanceId || state.lastOverviewData?.instanceId || "—"
  document.title = `${meta.title} | Bili-SyncPlay Admin`

  appRoot.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-eyebrow">管理控制台</span>
          <h1>Bili-SyncPlay</h1>
          <p>排障、治理和运行观察统一入口。</p>
        </div>
        <nav class="nav">
          ${renderNavLink("/overview", "概览")}
          ${renderNavLink("/rooms", "房间管理")}
          ${renderNavLink("/events", "运行事件")}
          ${renderNavLink("/audit-logs", "审计日志")}
          ${renderNavLink("/config", "配置摘要")}
        </nav>
        <div class="sidebar-meta-card">
          <div class="sidebar-meta">实例</div>
          <strong>${escapeHtml(instanceId)}</strong>
          <div class="sidebar-meta">统一管理当前服务实例的运行状态与治理动作。</div>
        </div>
      </aside>
      <main class="main">
        <div class="main-inner">
        <section class="topbar-card">
          <div class="topbar">
            <div class="page-title">
              <div class="page-kicker">运营控制台</div>
              <h2>${escapeHtml(meta.title)}</h2>
              <p>${escapeHtml(meta.description)}</p>
            </div>
            <div class="userbar">
              <span class="pill">${escapeHtml(state.me.username)}</span>
              <span class="pill">${escapeHtml(state.me.role)}</span>
              <button class="button ghost" data-action="logout">退出登录</button>
            </div>
          </div>
          <div class="topbar-subline">
            <div class="pill subtle">实例 ${escapeHtml(instanceId)}</div>
            <div class="topbar-note">桌面优先的后台工作台，面向排障、治理和运行观察。</div>
          </div>
        </section>
        ${state.notice ? `<div class="notice ${escapeHtml(state.notice.type)}">${escapeHtml(state.notice.message)}</div>` : ""}
        ${page.html}
        </div>
      </main>
    </div>
    ${renderDialog()}
  `

  bindCommonEvents(page)
  if (typeof page.bind === "function") {
    page.bind()
  }
}

function renderNavLink(path, label) {
  const active = state.currentRoute === path
  return `<a class="nav-link ${active ? "active" : ""}" href="${routeHref(path)}" data-nav="${escapeHtml(path)}">${escapeHtml(label)}</a>`
}

async function ensureInstanceId() {
  try {
    const config = await api.getConfig()
    state.instanceId = config.instanceId || ""
  } catch {
    // ignore; the current page can still render without instance metadata
  }
}

function renderDialog() {
  if (!state.dialog) {
    return `<div class="dialog-root" hidden></div>`
  }

  const isJsonPreview = state.dialog.mode === "json-preview"
  return `
    <div class="dialog-root">
      <form class="dialog-card ${isJsonPreview ? "json-preview-dialog" : ""}" id="confirm-dialog">
        <h3>${escapeHtml(state.dialog.title)}</h3>
        <p>${escapeHtml(state.dialog.description)}</p>
        ${
          isJsonPreview
            ? `<pre class="pre">${formatJson(state.dialog.payload)}</pre>`
            : `
              <div class="field">
                <label for="dialog-reason">操作原因</label>
                <textarea id="dialog-reason" name="reason" placeholder="可选，建议填写便于审计追溯。">${escapeHtml(state.dialog.defaultReason || "")}</textarea>
              </div>
            `
        }
        <div class="dialog-actions">
          <button type="button" class="button ghost" data-dialog-close>${isJsonPreview ? "关闭" : "取消"}</button>
          ${isJsonPreview ? "" : `<button type="submit" class="button primary">${escapeHtml(state.dialog.confirmLabel || "确认")}</button>`}
        </div>
      </form>
    </div>
  `
}

function bindCommonEvents(page) {
  document.querySelectorAll("[data-nav]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.preventDefault()
      navigate(element.getAttribute("data-nav"))
    })
  })

  document.querySelector("[data-action='logout']")?.addEventListener("click", async () => {
    try {
      await api.logout()
    } catch {
      // ignore
    }
    clearAuth()
    navigate("/login", true)
  })

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.getAttribute("data-copy"))
        showNotice("success", "已复制到剪贴板。")
      } catch {
        showNotice("error", "复制失败。")
      }
      render().catch(handleFatalRenderError)
    })
  })

  if (page.autoRefresh) {
    state.refreshHandle = setInterval(() => {
      render().catch(handleFatalRenderError)
    }, AUTO_REFRESH_MS)
  }

  if (state.notice?.type === "success") {
    setTimeout(() => {
      if (state.notice?.type === "success") {
        clearNotice()
        render().catch(handleFatalRenderError)
      }
    }, 2400)
  }
}

function renderLogin() {
  appRoot.innerHTML = `
    <div class="login-shell">
      <form class="login-card" id="login-form">
        <span class="brand-eyebrow">Admin Login</span>
        <h1>Bili-SyncPlay</h1>
        <p>使用服务端配置的管理员账号进入管理控制面板。</p>
        ${state.notice ? `<div class="notice ${escapeHtml(state.notice.type)}">${escapeHtml(state.notice.message)}</div>` : ""}
        <div class="field">
          <label for="username">用户名</label>
          <input id="username" name="username" autocomplete="username" required />
        </div>
        <div class="field" style="margin-top: 14px;">
          <label for="password">密码</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <div class="actions" style="margin-top: 18px;">
          <button class="button primary" type="submit">登录</button>
        </div>
      </form>
    </div>
  `
}

function bindLoginEvents() {
  document.querySelector("#login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const username = formData.get("username")?.toString().trim() || ""
    const password = formData.get("password")?.toString() || ""

    try {
      clearNotice()
      const result = await api.login({ username, password })
      setToken(result.token)
      state.me = await api.getMe()
      navigate("/overview", true)
    } catch (error) {
      showNotice("error", error.message || "登录失败。")
      renderLogin()
      bindLoginEvents()
    }
  })
}

async function loadPage() {
  switch (state.currentRoute) {
    case "/overview":
      return renderOverviewPage()
    case "/rooms":
      return renderRoomsPage()
    case "/events":
      return renderEventsPage()
    case "/audit-logs":
      return renderAuditLogsPage()
    case "/config":
      return renderConfigPage()
    default:
      if (state.currentRoute.startsWith("/rooms/")) {
        return renderRoomDetailPage(state.currentRoute.slice("/rooms/".length))
      }
      navigate("/overview", true)
      return renderOverviewPage()
  }
}

async function renderOverviewPage() {
  const [health, ready, overview] = await Promise.all([api.getHealth(), api.getReady(), api.getOverview()])
  state.lastOverviewData = overview.service
  const readyWarning = ready.status !== "ready"

  return {
    autoRefresh: state.overviewAutoRefresh,
    instanceId: overview.service.instanceId,
    html: `
      ${readyWarning ? `<div class="warning-banner">readyz 当前状态为 ${escapeHtml(ready.status)}，请优先检查房间存储与 Redis 连通性。</div>` : ""}
      <div class="section">
        <div class="toolbar toolbar-elevated">
          <div class="actions">
            <div class="pill">自动刷新 ${state.overviewAutoRefresh ? "开启" : "关闭"}</div>
            <button class="button ghost" data-toggle-overview-refresh>${state.overviewAutoRefresh ? "关闭自动刷新" : "开启自动刷新"}</button>
          </div>
          <button class="button" data-refresh-overview>立即刷新</button>
        </div>
        <div class="grid cards-4">
          ${metricCard("服务", escapeHtml(overview.service.name), `版本 ${escapeHtml(overview.service.version)}`)}
          ${metricCard("实例", escapeHtml(overview.service.instanceId), `启动于 ${new Date(overview.service.startedAt).toLocaleString()}`)}
          ${metricCard("健康检查", escapeHtml(health.status), `readyz ${escapeHtml(ready.status)}`)}
          ${metricCard("运行时长", escapeHtml(formatDuration(overview.service.uptimeMs)), "持续运行时长")}
        </div>
        <div class="grid cards-4">
          ${metricCard("连接数", overview.runtime.connectionCount, "当前 WebSocket 连接")}
          ${metricCard("在线房间", overview.runtime.activeRoomCount, "活跃房间")}
          ${metricCard("在线成员", overview.runtime.activeMemberCount, "当前在线成员")}
          ${metricCard("非过期房间", overview.rooms.totalNonExpired, `空闲 ${overview.rooms.idle}`)}
        </div>
        <div class="detail-grid">
          <section class="panel">
            <div class="section-header">
              <h3>存储状态</h3>
            </div>
            <dl class="kv">
              <dt>存储提供方</dt><dd>${escapeHtml(overview.storage.provider)}</dd>
              <dt>Redis</dt><dd>${renderStatus(overview.storage.redisConnected ? "success" : "warning", overview.storage.redisConnected ? "已连接" : "未连接")}</dd>
              <dt>readyz.roomStore</dt><dd>${escapeHtml(ready.checks.roomStore)}</dd>
              <dt>readyz.redis</dt><dd>${escapeHtml(ready.checks.redis)}</dd>
            </dl>
          </section>
          <section class="panel">
            <div class="section-header">
              <h3>事件统计</h3>
            </div>
            <dl class="kv">
              <dt>最近一分钟</dt><dd>room_created ${overview.events.lastMinute.room_created} / room_joined ${overview.events.lastMinute.room_joined} / rate_limited ${overview.events.lastMinute.rate_limited}</dd>
              <dt>最近一分钟</dt><dd>ws_connection_rejected ${overview.events.lastMinute.ws_connection_rejected} / error ${overview.events.lastMinute.error}</dd>
              <dt>累计</dt><dd>room_created ${overview.events.totals.room_created} / room_joined ${overview.events.totals.room_joined}</dd>
              <dt>累计</dt><dd>ws_connection_rejected ${overview.events.totals.ws_connection_rejected} / rate_limited ${overview.events.totals.rate_limited}</dd>
            </dl>
          </section>
        </div>
      </div>
    `,
    bind() {
      document.querySelector("[data-refresh-overview]")?.addEventListener("click", () => render().catch(handleFatalRenderError))
      document.querySelector("[data-toggle-overview-refresh]")?.addEventListener("click", () => {
        state.overviewAutoRefresh = !state.overviewAutoRefresh
        render().catch(handleFatalRenderError)
      })
    }
  }
}

function metricCard(label, value, meta) {
  return `
    <section class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
      <div class="metric-meta">${meta}</div>
    </section>
  `
}

function renderStatus(kind, text) {
  return `<span class="status ${escapeHtml(kind)}">${escapeHtml(text)}</span>`
}

async function renderRoomsPage() {
  const query = roomsQueryFromLocation()
  const data = await api.listRooms(query)

  return {
    instanceId: state.lastOverviewData?.instanceId,
    html: `
      <div class="section">
        <section class="panel panel-filter">
          <form id="rooms-filter" class="form-grid">
            ${textField("keyword", "房间号关键字", query.keyword)}
            ${selectField("status", "状态", query.status, [["all", "all"], ["active", "active"], ["idle", "idle"]])}
            ${selectField("sortBy", "排序字段", query.sortBy, [["lastActiveAt", "lastActiveAt"], ["createdAt", "createdAt"]])}
            ${selectField("sortOrder", "排序方向", query.sortOrder, [["desc", "desc"], ["asc", "asc"]])}
            ${textField("pageSize", "每页条数", String(query.pageSize), "number")}
            <div class="field inline" style="align-self: end;">
              <input id="includeExpired" name="includeExpired" type="checkbox" ${query.includeExpired ? "checked" : ""} />
              <label for="includeExpired">包含已过期房间</label>
            </div>
            <div class="actions" style="grid-column: 1 / -1;">
              <button class="button primary" type="submit">查询</button>
              <button class="button ghost" type="button" data-reset-rooms>重置</button>
            </div>
          </form>
        </section>
        <section class="table-card">
          <div class="toolbar table-toolbar">
            <div>
              <div class="table-title">房间列表</div>
              <div class="muted">共 ${data.pagination.total} 个结果</div>
            </div>
            <button class="button" data-refresh-rooms>刷新</button>
          </div>
          ${data.items.length === 0 ? `<div class="empty-state">当前筛选条件下没有房间。</div>` : `
            <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>房间号</th>
                  <th>实例</th>
                  <th>状态</th>
                  <th>成员</th>
                  <th>共享视频</th>
                  <th>播放状态</th>
                  <th>创建时间</th>
                  <th>最近活跃</th>
                  <th>过期时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${data.items.map((item) => `
                  <tr>
                    <td><a href="${routeHref(`/rooms/${item.roomCode}`)}" data-room-link="${escapeHtml(item.roomCode)}"><strong>${escapeHtml(item.roomCode)}</strong></a></td>
                    <td>${escapeHtml(item.instanceId || "—")}</td>
                    <td>${renderStatus(item.isActive ? "success" : "neutral", item.isActive ? "active" : "idle")}</td>
                    <td>${item.memberCount}</td>
                    <td>${escapeHtml(item.sharedVideo?.title || item.sharedVideo?.videoId || "未共享")}</td>
                    <td>${escapeHtml(formatPlayback(item.playback))}</td>
                    <td>${formatDateTime(item.createdAt)}</td>
                    <td>${formatDateTime(item.lastActiveAt)}</td>
                    <td>${formatDateTime(item.expiresAt)}</td>
                    <td>${roomActionButtons(item.roomCode)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
            </div>
            ${renderPagination(query.page, query.pageSize, data.pagination.total, "rooms")}
          `}
        </section>
      </div>
    `,
    bind() {
      bindRoomsListEvents(query)
    }
  }
}

function roomsQueryFromLocation() {
  const params = new URLSearchParams(location.search)
  return {
    keyword: params.get("keyword") || "",
    status: params.get("status") || "all",
    includeExpired: params.get("includeExpired") === "true",
    sortBy: params.get("sortBy") || "lastActiveAt",
    sortOrder: params.get("sortOrder") || "desc",
    page: Number(params.get("page") || "1"),
    pageSize: Number(params.get("pageSize") || "20")
  }
}

function roomActionButtons(roomCode) {
  const view = `<button class="button link" type="button" data-open-room="${escapeHtml(roomCode)}">查看详情</button>`
  if (!canManage()) {
    return `<div class="table-actions">${view}</div>`
  }

  return `
    <div class="table-actions">
      ${view}
      <button class="button link" type="button" data-room-action="close" data-room-code="${escapeHtml(roomCode)}">关闭房间</button>
      <button class="button link" type="button" data-room-action="expire" data-room-code="${escapeHtml(roomCode)}">提前过期</button>
      <button class="button link" type="button" data-room-action="clear-video" data-room-code="${escapeHtml(roomCode)}">清空共享视频</button>
    </div>
  `
}

function renderPagination(page, pageSize, total, scope) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  return `
    <div class="pagination">
      <div>第 ${page} / ${totalPages} 页，共 ${total} 条</div>
      <div class="actions">
        <button class="button" type="button" data-page-scope="${scope}" data-page-target="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
        <button class="button" type="button" data-page-scope="${scope}" data-page-target="${page + 1}" ${page >= totalPages ? "disabled" : ""}>下一页</button>
      </div>
    </div>
  `
}

function bindRoomsListEvents(query) {
  document.querySelector("#rooms-filter")?.addEventListener("submit", (event) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const nextQuery = {
      keyword: formData.get("keyword")?.toString().trim() || "",
      status: formData.get("status")?.toString() || "all",
      includeExpired: formData.get("includeExpired") === "on",
      sortBy: formData.get("sortBy")?.toString() || "lastActiveAt",
      sortOrder: formData.get("sortOrder")?.toString() || "desc",
      page: 1,
      pageSize: Number(formData.get("pageSize") || query.pageSize || 20)
    }
    history.replaceState(null, "", `${routeHref("/rooms")}${serializeQuery(nextQuery)}`)
    render().catch(handleFatalRenderError)
  })

  document.querySelector("[data-reset-rooms]")?.addEventListener("click", () => {
    history.replaceState(null, "", routeHref("/rooms"))
    render().catch(handleFatalRenderError)
  })

  document.querySelector("[data-refresh-rooms]")?.addEventListener("click", () => render().catch(handleFatalRenderError))

  document.querySelectorAll("[data-open-room],[data-room-link]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.preventDefault()
      navigate(`/rooms/${element.getAttribute("data-open-room") || element.getAttribute("data-room-link")}`)
    })
  })

  bindPageButtons("/rooms")
  bindRoomActionButtons(() => render().catch(handleFatalRenderError))
}

function bindPageButtons(basePath) {
  document.querySelectorAll("[data-page-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const params = new URLSearchParams(location.search)
      params.set("page", button.getAttribute("data-page-target"))
      history.replaceState(null, "", `${routeHref(basePath)}?${params.toString()}`)
      render().catch(handleFatalRenderError)
    })
  })
}

function bindRoomActionButtons(onDone) {
  document.querySelectorAll("[data-room-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const roomCode = button.getAttribute("data-room-code")
      const action = button.getAttribute("data-room-action")
      const config = {
        close: {
          title: `关闭房间 ${roomCode}`,
          description: "这会断开该房间全部在线成员，并删除房间数据。",
          confirmLabel: "确认关闭",
          successMessage: `房间 ${roomCode} 已关闭。`,
          onConfirm: (reason) => api.closeRoom(roomCode, reason)
        },
        expire: {
          title: `提前过期房间 ${roomCode}`,
          description: "无在线成员时会直接清理，有在线成员时会标记为尽快过期。",
          confirmLabel: "确认过期",
          successMessage: `房间 ${roomCode} 已处理为提前过期。`,
          onConfirm: (reason) => api.expireRoom(roomCode, reason)
        },
        "clear-video": {
          title: `清空房间 ${roomCode} 的共享视频`,
          description: "这会清空当前共享视频和播放状态，并向在线成员广播新状态。",
          confirmLabel: "确认清空",
          successMessage: `房间 ${roomCode} 的共享视频已清空。`,
          onConfirm: (reason) => api.clearRoomVideo(roomCode, reason)
        }
      }[action]

      await confirmAction(config)
      if (typeof onDone === "function") {
        onDone()
      }
    })
  })
}

async function renderRoomDetailPage(roomCode) {
  try {
    const detail = await api.getRoomDetail(roomCode)
    return {
      meta: {
        title: `房间 ${detail.room.roomCode}`,
        description: "查看房间摘要、共享视频、在线成员与最近事件。"
      },
      instanceId: detail.instanceId,
      html: `
        <div class="section">
          <div class="toolbar">
            <div class="actions">
              <button class="button ghost" data-nav-back>返回房间列表</button>
              <button class="button" data-refresh-detail>刷新</button>
            </div>
            ${canManage() ? `
              <div class="actions">
                <button class="button danger" data-room-action="close" data-room-code="${escapeHtml(roomCode)}">关闭房间</button>
                <button class="button" data-room-action="expire" data-room-code="${escapeHtml(roomCode)}">提前过期</button>
                <button class="button" data-room-action="clear-video" data-room-code="${escapeHtml(roomCode)}">清空共享视频</button>
              </div>
            ` : ""}
          </div>
          <div class="detail-grid">
            <section class="panel">
              <div class="section-header"><h3>房间摘要</h3></div>
              <dl class="kv">
                <dt>房间号</dt><dd><strong>${escapeHtml(detail.room.roomCode)}</strong></dd>
                <dt>实例</dt><dd>${escapeHtml(detail.room.instanceId || "—")}</dd>
                <dt>在线状态</dt><dd>${renderStatus(detail.room.isActive ? "success" : "neutral", detail.room.isActive ? "active" : "idle")}</dd>
                <dt>成员数</dt><dd>${detail.room.memberCount}</dd>
                <dt>创建时间</dt><dd>${formatDateTime(detail.room.createdAt)}</dd>
                <dt>最近活跃</dt><dd>${formatDateTime(detail.room.lastActiveAt)}</dd>
                <dt>过期时间</dt><dd>${formatDateTime(detail.room.expiresAt)}</dd>
              </dl>
            </section>
            <section class="panel">
              <div class="section-header"><h3>共享视频与播放状态</h3></div>
              <div class="media-summary">
                <div class="media-summary-title">${escapeHtml(detail.room.sharedVideo?.title || "未共享视频")}</div>
                <div class="media-summary-meta">
                  ${detail.room.sharedVideo?.videoId ? `<span class="pill subtle">ID ${escapeHtml(detail.room.sharedVideo.videoId)}</span>` : renderEmptyValue("无视频 ID")}
                  ${detail.room.playback ? renderResultBadge(detail.room.playback.paused ? "paused" : "playing") : renderEmptyValue("未同步")}
                </div>
              </div>
              <dl class="kv">
                <dt>标题</dt><dd>${escapeHtml(detail.room.sharedVideo?.title || "未共享")}</dd>
                <dt>视频 ID</dt><dd>${detail.room.sharedVideo?.videoId ? `<span class="code">${escapeHtml(detail.room.sharedVideo.videoId)}</span>` : renderEmptyValue()}</dd>
                <dt>URL</dt><dd>${detail.room.sharedVideo?.url ? `<a href="${escapeHtml(detail.room.sharedVideo.url)}" target="_blank" rel="noreferrer">${escapeHtml(detail.room.sharedVideo.url)}</a>` : renderEmptyValue()}</dd>
                <dt>播放状态</dt><dd>${detail.room.playback ? renderResultBadge(detail.room.playback.paused ? "paused" : "playing") : renderEmptyValue("未同步")}</dd>
                <dt>当前时间</dt><dd>${detail.room.playback ? `${Number(detail.room.playback.currentTime || 0).toFixed(1)}s` : renderEmptyValue()}</dd>
                <dt>播放速度</dt><dd>${detail.room.playback ? `x${Number(detail.room.playback.playbackRate || 1).toFixed(2)}` : renderEmptyValue()}</dd>
              </dl>
            </section>
          </div>
          <section class="table-card">
            <div class="toolbar table-toolbar">
              <div>
                <div class="table-title">在线成员</div>
                <div class="muted">支持复制会话和成员标识。</div>
              </div>
              <div class="pill subtle">在线 ${detail.members.length}</div>
            </div>
            ${detail.members.length === 0 ? `<div class="empty-state">当前没有在线成员。</div>` : `
              <div class="table-scroll">
              <table class="detail-table members-table">
                <thead>
                  <tr>
                    <th>显示名</th>
                    <th>memberId</th>
                    <th>sessionId</th>
                    <th>加入时间</th>
                    <th>远端地址</th>
                    <th>Origin</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${detail.members.map((member) => `
                    <tr>
                      <td>${escapeHtml(member.displayName)}</td>
                      <td><div class="copy-stack"><span class="code">${escapeHtml(member.memberId)}</span><button class="button link" type="button" data-copy="${escapeHtml(member.memberId)}">复制</button></div></td>
                      <td><div class="copy-stack"><span class="code">${escapeHtml(member.sessionId)}</span><button class="button link" type="button" data-copy="${escapeHtml(member.sessionId)}">复制</button></div></td>
                      <td>${formatDateTime(member.joinedAt)}</td>
                      <td>${member.remoteAddress ? `<div class="copy-stack"><span class="code">${escapeHtml(member.remoteAddress)}</span><button class="button link" type="button" data-copy="${escapeHtml(member.remoteAddress)}">复制</button></div>` : renderEmptyValue()}</td>
                      <td>${member.origin ? escapeHtml(member.origin) : renderEmptyValue()}</td>
                      <td>${memberActionButtons(roomCode, member)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
              </div>
            `}
          </section>
          <section class="table-card">
            <div class="toolbar table-toolbar">
              <div>
                <div class="table-title">最近事件</div>
                <div class="muted">默认展示最近 20 条，服务重启后事件存储会丢失。</div>
              </div>
              <button class="button ghost" data-jump-events="${escapeHtml(roomCode)}">带筛选跳转到事件页</button>
            </div>
            ${detail.recentEvents.length === 0 ? `<div class="empty-state">暂无近期事件。</div>` : `
              <div class="table-scroll">
              <table class="detail-table room-events-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>事件名</th>
                    <th>会话</th>
                    <th>结果</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  ${detail.recentEvents.map((event) => `
                    <tr>
                      <td>${formatDateTime(event.timestamp)}</td>
                      <td>${escapeHtml(event.event)}</td>
                      <td>${event.sessionId ? `<span class="code">${escapeHtml(event.sessionId)}</span>` : renderEmptyValue()}</td>
                      <td>${event.result ? renderResultBadge(event.result) : renderEmptyValue()}</td>
                      <td><button class="button link" type="button" data-view-json='${escapeHtml(JSON.stringify(event.details))}'>查看 JSON</button></td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
              </div>
            `}
          </section>
        </div>
      `,
      bind() {
        document.querySelector("[data-nav-back]")?.addEventListener("click", () => navigate("/rooms"))
        document.querySelector("[data-refresh-detail]")?.addEventListener("click", () => render().catch(handleFatalRenderError))
        document.querySelector("[data-jump-events]")?.addEventListener("click", (event) => {
          const targetRoomCode = event.currentTarget.getAttribute("data-jump-events")
          navigateToUrl(
            `${routeHref("/events")}?${new URLSearchParams({ roomCode: targetRoomCode }).toString()}`,
            "/events",
            true
          )
        })
        bindRoomActionButtons(() => render().catch(handleFatalRenderError))
        bindMemberActionButtons(roomCode)
        bindJsonButtons()
      }
    }
  } catch (error) {
    if (error.code === "room_not_found") {
      return {
        html: `
          <div class="empty-state">
            <h3>房间不存在</h3>
            <p class="muted">房间 ${escapeHtml(roomCode)} 可能已被删除或已过期。</p>
            <div class="actions" style="justify-content: center;">
              <button class="button" data-nav-back>返回房间列表</button>
            </div>
          </div>
        `,
        bind() {
          document.querySelector("[data-nav-back]")?.addEventListener("click", () => navigate("/rooms"))
        }
      }
    }
    throw error
  }
}

function memberActionButtons(roomCode, member) {
  if (!canManage()) {
    return "—"
  }

  return `
    <div class="table-actions">
      <button class="button link" type="button" data-member-action="kick" data-room-code="${escapeHtml(roomCode)}" data-member-id="${escapeHtml(member.memberId)}">踢出成员</button>
      <button class="button link" type="button" data-member-action="disconnect" data-room-code="${escapeHtml(roomCode)}" data-session-id="${escapeHtml(member.sessionId)}">断开会话</button>
    </div>
  `
}

function bindMemberActionButtons(roomCode) {
  document.querySelectorAll("[data-member-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.getAttribute("data-member-action")
      if (action === "kick") {
        const memberId = button.getAttribute("data-member-id")
        await confirmAction({
          title: `踢出成员 ${memberId}`,
          description: "这会断开该成员当前连接。",
          confirmLabel: "确认踢出",
          successMessage: `成员 ${memberId} 已被踢出。`,
          onConfirm: (reason) => api.kickMember(roomCode, memberId, reason)
        })
      } else {
        const sessionId = button.getAttribute("data-session-id")
        await confirmAction({
          title: `断开会话 ${sessionId}`,
          description: "这会强制断开指定会话。",
          confirmLabel: "确认断开",
          successMessage: `会话 ${sessionId} 已断开。`,
          onConfirm: (reason) => api.disconnectSession(sessionId, reason)
        })
      }
      render().catch(handleFatalRenderError)
    })
  })
}

async function renderEventsPage() {
  const query = listQueryFromLocation({ pageSize: "20" })
  const data = await api.listEvents(query)

  return {
    html: renderLogPage({
      title: "运行事件列表",
      muted: "仅保证近期事件，服务重启后事件存储可能丢失。",
      filterKicker: "事件筛选",
      filterIntro: "按事件名、房间号、会话、来源和时间范围筛选近期运行事件。",
      tableClass: "events-table",
      filters: `
        ${textField("event", "事件名", query.event)}
        ${textField("roomCode", "房间号", query.roomCode)}
        ${textField("sessionId", "会话 ID", query.sessionId)}
        ${textField("remoteAddress", "远端地址", query.remoteAddress)}
        ${textField("origin", "Origin", query.origin)}
        ${textField("result", "结果", query.result)}
        ${textField("from", "开始时间戳(ms)", query.from, "number")}
        ${textField("to", "结束时间戳(ms)", query.to, "number")}
        ${textField("pageSize", "每页条数", query.pageSize, "number")}
      `,
      rows: data.items.map((item) => `
        <tr>
          <td>${formatDateTime(item.timestamp)}</td>
          <td>${escapeHtml(item.event)}</td>
          <td>${item.roomCode ? escapeHtml(item.roomCode) : renderEmptyValue()}</td>
          <td>${item.sessionId ? `<span class="code">${escapeHtml(item.sessionId)}</span>` : renderEmptyValue()}</td>
          <td>${item.remoteAddress ? `<span class="code">${escapeHtml(item.remoteAddress)}</span>` : renderEmptyValue()}</td>
          <td>${item.origin ? escapeHtml(item.origin) : renderEmptyValue()}</td>
          <td>${item.result ? renderResultBadge(item.result) : renderEmptyValue()}</td>
          <td><button class="button link" type="button" data-view-json='${escapeHtml(JSON.stringify(item.details))}'>查看 JSON</button></td>
        </tr>
      `).join(""),
      headers: "<th>时间</th><th>事件名</th><th>房间号</th><th>会话 ID</th><th>远端地址</th><th>Origin</th><th>结果</th><th>详情</th>",
      data,
      query,
      basePath: "/events",
      formId: "events-filter"
    }),
    bind() {
      bindListFilter("/events", "events-filter")
      bindPageButtons("/events")
      bindJsonButtons()
    }
  }
}

async function renderAuditLogsPage() {
  const query = listQueryFromLocation({ pageSize: "20" })
  const data = await api.listAuditLogs(query)

  return {
    html: renderLogPage({
      title: "审计日志",
      muted: "viewer 也可查看；写操作成功后可回到这里确认最新留痕。",
      filterKicker: "审计筛选",
      filterIntro: "按操作人、动作、目标和结果定位后台治理动作的留痕记录。",
      tableClass: "audit-table",
      filters: `
        ${textField("actor", "操作人", query.actor)}
        ${textField("action", "动作", query.action)}
        ${textField("targetType", "目标类型", query.targetType)}
        ${textField("targetId", "目标 ID", query.targetId)}
        ${textField("result", "结果", query.result)}
        ${textField("from", "开始时间戳(ms)", query.from, "number")}
        ${textField("to", "结束时间戳(ms)", query.to, "number")}
        ${textField("pageSize", "每页条数", query.pageSize, "number")}
      `,
      rows: data.items.map((item) => `
        <tr>
          <td>${formatDateTime(item.timestamp)}</td>
          <td>${escapeHtml(item.actor.username)}</td>
          <td>${renderResultBadge(item.actor.role)}</td>
          <td>${escapeHtml(item.action)}</td>
          <td>${escapeHtml(item.targetType)}</td>
          <td>${item.targetId ? `<span class="code">${escapeHtml(item.targetId)}</span>` : renderEmptyValue()}</td>
          <td>${renderResultBadge(item.result)}</td>
          <td>${item.reason ? escapeHtml(item.reason) : renderEmptyValue()}</td>
          <td>${item.instanceId ? escapeHtml(item.instanceId) : renderEmptyValue()}</td>
          <td><button class="button link" type="button" data-view-json='${escapeHtml(JSON.stringify(item.request))}'>查看请求</button></td>
        </tr>
      `).join(""),
      headers: "<th>时间</th><th>操作人</th><th>角色</th><th>动作</th><th>目标类型</th><th>目标 ID</th><th>结果</th><th>原因</th><th>实例</th><th>请求</th>",
      data,
      query,
      basePath: "/audit-logs",
      formId: "audit-filter"
    }),
    bind() {
      bindListFilter("/audit-logs", "audit-filter")
      bindPageButtons("/audit-logs")
      bindJsonButtons()
    }
  }
}

function renderLogPage(options) {
  return `
    <div class="section">
      <section class="panel panel-filter">
        <div class="panel-intro">
          <div class="panel-intro-kicker">${escapeHtml(options.filterKicker || "筛选条件")}</div>
          <div class="panel-intro-text">${escapeHtml(options.filterIntro || "按筛选条件快速定位目标数据。")}</div>
        </div>
        <form id="${escapeHtml(options.formId)}" class="form-grid">
          ${options.filters}
          <div class="actions" style="grid-column: 1 / -1;">
            <button class="button primary" type="submit">查询</button>
            <button class="button ghost" type="button" data-reset-list="${escapeHtml(options.basePath)}">重置</button>
          </div>
        </form>
      </section>
      <section class="table-card">
        <div class="toolbar table-toolbar">
          <div>
            <div class="table-title">${escapeHtml(options.title)}</div>
            <div class="muted">${escapeHtml(options.muted)}</div>
          </div>
          <div class="pill subtle">总数 ${escapeHtml(options.data.total)}</div>
        </div>
        ${options.data.items.length === 0 ? `<div class="empty-state">没有匹配结果。</div>` : `
          <div class="table-scroll">
          <table class="logs-table ${escapeHtml(options.tableClass || "")}">
            <thead><tr>${options.headers}</tr></thead>
            <tbody>${options.rows}</tbody>
          </table>
          </div>
          ${renderPagination(Number(options.query.page || 1), Number(options.query.pageSize || 20), options.data.total, "logs")}
        `}
      </section>
    </div>
  `
}

function listQueryFromLocation(defaults = {}) {
  const params = new URLSearchParams(location.search)
  return {
    event: params.get("event") || "",
    roomCode: params.get("roomCode") || "",
    sessionId: params.get("sessionId") || "",
    remoteAddress: params.get("remoteAddress") || "",
    origin: params.get("origin") || "",
    result: params.get("result") || "",
    actor: params.get("actor") || "",
    action: params.get("action") || "",
    targetType: params.get("targetType") || "",
    targetId: params.get("targetId") || "",
    from: params.get("from") || "",
    to: params.get("to") || "",
    page: Number(params.get("page") || "1"),
    pageSize: params.get("pageSize") || defaults.pageSize || "20"
  }
}

function bindListFilter(basePath, formId) {
  document.querySelector(`#${formId}`)?.addEventListener("submit", (event) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    const query = Object.fromEntries(formData.entries())
    query.page = "1"
    history.replaceState(null, "", `${routeHref(basePath)}${serializeQuery(query)}`)
    render().catch(handleFatalRenderError)
  })

  document.querySelector("[data-reset-list]")?.addEventListener("click", () => {
    history.replaceState(null, "", routeHref(basePath))
    render().catch(handleFatalRenderError)
  })
}

function bindJsonButtons() {
  document.querySelectorAll("[data-view-json]").forEach((button) => {
    button.addEventListener("click", async () => {
      const payload = JSON.parse(button.getAttribute("data-view-json"))
      await openReasonDialog({
        title: "原始 JSON",
        description: "以下内容仅供查看，可复制进行排查。",
        mode: "json-preview",
        payload
      })
    })
  })
}

async function renderConfigPage() {
  const config = await api.getConfig()
  return {
    instanceId: config.instanceId,
    html: `
      <div class="section">
        <div class="detail-grid">
          <section class="panel config-panel">
            <div class="section-header"><h3>实例与持久化</h3></div>
            <dl class="kv config-kv">
              <dt>实例 ID</dt><dd>${escapeHtml(config.instanceId)}</dd>
              <dt>存储提供方</dt><dd>${escapeHtml(config.persistence.provider)}</dd>
              <dt>空房间保留时长</dt><dd>${escapeHtml(config.persistence.emptyRoomTtlMs)} ms</dd>
              <dt>房间清理间隔</dt><dd>${escapeHtml(config.persistence.roomCleanupIntervalMs)} ms</dd>
              <dt>已配置 Redis</dt><dd>${renderStatus(config.persistence.redisConfigured ? "success" : "neutral", config.persistence.redisConfigured ? "是" : "否")}</dd>
            </dl>
          </section>
          <section class="panel config-panel">
            <div class="section-header"><h3>管理后台配置</h3></div>
            <dl class="kv config-kv">
              <dt>已启用后台</dt><dd>${renderStatus(config.admin.configured ? "success" : "warning", config.admin.configured ? "是" : "否")}</dd>
              <dt>用户名</dt><dd>${config.admin.username ? escapeHtml(config.admin.username) : renderEmptyValue()}</dd>
              <dt>角色</dt><dd>${config.admin.role ? escapeHtml(config.admin.role) : renderEmptyValue()}</dd>
              <dt>会话有效期</dt><dd>${config.admin.sessionTtlMs ? `${escapeHtml(config.admin.sessionTtlMs)} ms` : renderEmptyValue()}</dd>
            </dl>
          </section>
        </div>
        <section class="panel config-panel">
          <div class="section-header"><h3>安全配置</h3></div>
          <dl class="kv config-kv">
            <dt>允许的 Origin</dt>
            <dd>
              ${
                config.security.allowedOrigins.length
                  ? `<div class="config-origin-list">${config.security.allowedOrigins
                      .map((item) => `<span class="config-origin code">${escapeHtml(item)}</span>`)
                      .join("")}</div>`
                  : renderEmptyValue("未设置")
              }
            </dd>
            <dt>开发环境允许缺省 Origin</dt><dd>${renderStatus(config.security.allowMissingOriginInDev ? "warning" : "neutral", config.security.allowMissingOriginInDev ? "是" : "否")}</dd>
            <dt>信任代理请求头</dt><dd>${renderStatus(config.security.trustProxyHeaders ? "warning" : "neutral", config.security.trustProxyHeaders ? "是" : "否")}</dd>
            <dt>单 IP 最大连接数</dt><dd>${config.security.maxConnectionsPerIp}</dd>
            <dt>每分钟连接尝试上限</dt><dd>${config.security.connectionAttemptsPerMinute}</dd>
            <dt>单房间最大成员数</dt><dd>${config.security.maxMembersPerRoom}</dd>
            <dt>最大消息字节数</dt><dd>${config.security.maxMessageBytes}</dd>
            <dt>非法消息断开阈值</dt><dd>${config.security.invalidMessageCloseThreshold}</dd>
          </dl>
          <div class="config-rate-limits">
            <div class="config-rate-limits-title">限流配置</div>
            <pre class="pre">${formatJson(config.security.rateLimits)}</pre>
          </div>
        </section>
      </div>
    `
  }
}

function textField(name, label, value, type = "text") {
  return `
    <div class="field">
      <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
      <input id="${escapeHtml(name)}" name="${escapeHtml(name)}" type="${escapeHtml(type)}" value="${escapeHtml(value || "")}" />
    </div>
  `
}

function selectField(name, label, value, options) {
  return `
    <div class="field">
      <label for="${escapeHtml(name)}">${escapeHtml(label)}</label>
      <select id="${escapeHtml(name)}" name="${escapeHtml(name)}">
        ${options.map(([optionValue, optionLabel]) => `<option value="${escapeHtml(optionValue)}" ${value === optionValue ? "selected" : ""}>${escapeHtml(optionLabel)}</option>`).join("")}
      </select>
    </div>
  `
}

const api = {
  async request(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || "GET",
      headers: {
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    })

    const contentType = response.headers.get("content-type") || ""
    const payload = contentType.includes("application/json") ? await response.json() : null

    if (response.status === 401) {
      clearAuth()
      navigate("/login", true)
      throw { code: "unauthorized", message: "登录已失效，请重新登录。" }
    }

    if (!response.ok || !payload?.ok) {
      throw {
        code: payload?.error?.code || "request_failed",
        message: payload?.error?.message || "请求失败。"
      }
    }

    return payload.data
  },
  login(payload) {
    return this.request("/api/admin/auth/login", { method: "POST", body: payload })
  },
  logout() {
    return this.request("/api/admin/auth/logout", { method: "POST" })
  },
  getMe() {
    return this.request("/api/admin/me")
  },
  getHealth() {
    return this.request("/healthz")
  },
  getReady() {
    return this.request("/readyz")
  },
  getOverview() {
    return this.request("/api/admin/overview")
  },
  listRooms(query) {
    return this.request(`/api/admin/rooms${serializeQuery(query)}`)
  },
  getRoomDetail(roomCode) {
    return this.request(`/api/admin/rooms/${encodeURIComponent(roomCode)}`)
  },
  closeRoom(roomCode, reason) {
    return this.request(`/api/admin/rooms/${encodeURIComponent(roomCode)}/close`, { method: "POST", body: { reason } })
  },
  expireRoom(roomCode, reason) {
    return this.request(`/api/admin/rooms/${encodeURIComponent(roomCode)}/expire`, { method: "POST", body: { reason } })
  },
  clearRoomVideo(roomCode, reason) {
    return this.request(`/api/admin/rooms/${encodeURIComponent(roomCode)}/clear-video`, { method: "POST", body: { reason } })
  },
  kickMember(roomCode, memberId, reason) {
    return this.request(`/api/admin/rooms/${encodeURIComponent(roomCode)}/members/${encodeURIComponent(memberId)}/kick`, {
      method: "POST",
      body: { reason }
    })
  },
  disconnectSession(sessionId, reason) {
    return this.request(`/api/admin/sessions/${encodeURIComponent(sessionId)}/disconnect`, {
      method: "POST",
      body: { reason }
    })
  },
  listEvents(query) {
    return this.request(`/api/admin/events${serializeQuery(query)}`)
  },
  listAuditLogs(query) {
    return this.request(`/api/admin/audit-logs${serializeQuery(query)}`)
  },
  getConfig() {
    return this.request("/api/admin/config")
  }
}

window.addEventListener("popstate", () => {
  state.currentRoute = normalizePath(location.pathname)
  render().catch(handleFatalRenderError)
})

bootstrap().catch((error) => {
  console.error(error)
  showNotice("error", "管理控制面板初始化失败。")
  render().catch(handleFatalRenderError)
})
