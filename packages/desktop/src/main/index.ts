import crypto from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type Cookie,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents,
} from "electron"
import {
  AuthType,
  buildCookieHeader,
  CheckinResultStatus,
  type CheckinExecutionProgress,
  deriveAccountAuthState,
  executeCheckinRun,
  fetchNewApiSelf,
  FileSystemRepository,
  hasUsableAuth,
  importBackupIntoRepository,
  isAnyrouterSiteType,
  isSupportedCheckinSiteType,
  isWongSiteType,
  type SiteAccount,
} from "@all-api-hub/core"
import {
  TASK_PROGRESS_CHANNEL,
  type DesktopTaskKind,
  type DesktopTaskProgressPayload,
} from "../shared/taskProgress.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, "..")
const rendererIndexPath = path.join(packageRoot, "dist-renderer", "index.html")
const preloadPath = path.join(packageRoot, "dist-electron", "preload.cjs")

let mainWindow: BrowserWindow | null = null
let repository: FileSystemRepository

type RefreshAllAccountsProgress = (
  payload: Omit<DesktopTaskProgressPayload, "taskId" | "kind" | "title">,
) => void | Promise<void>

function getRepository(): FileSystemRepository {
  if (!repository) {
    throw new Error("Repository not initialized")
  }
  return repository
}

function sendTaskProgress(
  target: WebContents,
  payload: DesktopTaskProgressPayload,
) {
  if (target.isDestroyed()) {
    return
  }

  target.send(TASK_PROGRESS_CHANNEL, payload)
}

function createTaskProgressEmitter(
  target: WebContents,
  kind: DesktopTaskKind,
  title: string,
) {
  const taskId = crypto.randomUUID()

  return (
    payload: Omit<DesktopTaskProgressPayload, "taskId" | "kind" | "title">,
  ) => {
    sendTaskProgress(target, {
      taskId,
      kind,
      title,
      ...payload,
    })
  }
}

function toDesktopProgressStatus(
  status: CheckinResultStatus,
): DesktopTaskProgressPayload["status"] {
  return status
}

function mapCheckinProgress(
  progress: CheckinExecutionProgress,
): Omit<DesktopTaskProgressPayload, "taskId" | "kind" | "title"> {
  return {
    phase: progress.phase,
    total: progress.total,
    processed: progress.processed,
    currentAccountId: progress.accountId,
    currentSiteName: progress.siteName,
    detail: progress.message,
    status:
      progress.phase === "account_started"
        ? "running"
        : progress.status
          ? toDesktopProgressStatus(progress.status)
          : undefined,
    success: progress.summary.success,
    alreadyChecked: progress.summary.alreadyChecked,
    failed: progress.summary.failed,
    skipped: progress.summary.skipped,
    manualActionRequired: progress.summary.manualActionRequired,
  }
}

function normalizeExternalUrl(rawUrl: string): string {
  const value = rawUrl.trim()
  if (!value) {
    throw new Error("站点 URL 为空，无法打开网站")
  }

  const parsed = new URL(value)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持打开 http 或 https 网站")
  }

  return parsed.toString()
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

function shouldToggleDevTools(input: {
  key: string
  type: string
  control?: boolean
  meta?: boolean
  shift?: boolean
}): boolean {
  if (input.type !== "keyDown") {
    return false
  }

  const key = input.key.toLowerCase()
  return key === "f12" || ((input.control || input.meta) && input.shift && key === "i")
}

async function verifyRendererBootstrap(
  window: BrowserWindow,
  label: string,
  reportFailure: (title: string, detail: string) => void,
) {
  if (window.isDestroyed()) {
    return
  }

  try {
    const status = (await window.webContents.executeJavaScript(
      `
        (() => {
          const root = document.getElementById("root")
          return {
            hasDesktopApi:
              typeof window.desktopApi === "object" &&
              typeof window.desktopApi?.bootstrap === "function",
            href: window.location.href,
            readyState: document.readyState,
            rootChildren: root?.childElementCount ?? 0,
          }
        })()
      `,
      true,
    )) as {
      hasDesktopApi?: boolean
      href?: string
      readyState?: string
      rootChildren?: number
    }

    if (!status.hasDesktopApi) {
      reportFailure(
        "桌面桥接未注入",
        [
          `窗口: ${label}`,
          `地址: ${status.href ?? ""}`,
          "渲染层未检测到 window.desktopApi，通常表示 preload 脚本未成功执行。",
        ].join("\n"),
      )
      return
    }

    if ((status.rootChildren ?? 0) === 0) {
      reportFailure(
        "渲染页面未完成启动",
        [
          `窗口: ${label}`,
          `地址: ${status.href ?? ""}`,
          `DOM 状态: ${status.readyState ?? "unknown"}`,
          `#root 子节点数: ${status.rootChildren ?? 0}`,
          "这通常表示渲染脚本或样式资源未成功加载。",
        ].join("\n"),
      )
    }
  } catch (error) {
    console.error(`[desktop:${label}] renderer bootstrap check failed`, error)
  }
}

function installWindowDiagnostics(
  window: BrowserWindow,
  options: {
    label: string
    showDialogs?: boolean
    checkBootstrap?: boolean
  },
) {
  const { label, showDialogs = false, checkBootstrap = false } = options
  let surfacedFailure = false

  const reportFailure = (title: string, detail: string) => {
    console.error(`[desktop:${label}] ${title}\n${detail}`)

    if (!showDialogs || surfacedFailure) {
      return
    }

    surfacedFailure = true
    if (!window.isDestroyed() && !window.webContents.isDevToolsOpened()) {
      window.webContents.openDevTools({ mode: "detach" })
    }
    dialog.showErrorBox(title, detail)
  }

  window.webContents.on("before-input-event", (event, input) => {
    if (!shouldToggleDevTools(input)) {
      return
    }

    event.preventDefault()
    window.webContents.toggleDevTools()
  })

  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      reportFailure(
        "页面加载失败",
        [
          `窗口: ${label}`,
          `范围: ${isMainFrame ? "主框架" : "子资源"}`,
          `地址: ${validatedURL}`,
          `错误: ${errorCode} ${errorDescription}`,
        ].join("\n"),
      )
    },
  )

  window.webContents.on("render-process-gone", (_event, details) => {
    reportFailure(
      "渲染进程异常退出",
      [
        `窗口: ${label}`,
        `原因: ${details.reason}`,
        `退出码: ${details.exitCode}`,
      ].join("\n"),
    )
  })

  window.on("unresponsive", () => {
    reportFailure("窗口无响应", `窗口: ${label}`)
  })

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${label}:console:${level}] ${sourceId}:${line} ${message}`)

    if (
      /Failed to load resource|ERR_FILE_NOT_FOUND|ERR_ABORTED|Not allowed to load local resource/i.test(
        message,
      )
    ) {
      reportFailure(
        "渲染资源加载失败",
        [
          `窗口: ${label}`,
          `来源: ${sourceId}:${line}`,
          `消息: ${message}`,
        ].join("\n"),
      )
    }
  })

  if (checkBootstrap) {
    window.webContents.on("did-finish-load", () => {
      setTimeout(() => {
        void verifyRendererBootstrap(window, label, reportFailure)
      }, 1200)
    })
  }
}

async function extractTokenCandidate(
  window: BrowserWindow,
  siteUrl: string,
): Promise<string> {
  const currentUrl = window.webContents.getURL()
  if (!sameOrigin(currentUrl, siteUrl)) {
    return ""
  }

  const token = await window.webContents.executeJavaScript(`
    (() => {
      const storages = [window.localStorage, window.sessionStorage]
      const matches = []
      const shouldCheckKey = (key) =>
        /access[_-]?token|token|jwt|auth/i.test(String(key || ""))

      for (const storage of storages) {
        if (!storage) continue
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index)
          if (!key) continue

          const value = storage.getItem(key)
          if (value && shouldCheckKey(key) && value.length > 12) {
            matches.push(value)
          }

          if (!value) continue
          try {
            const parsed = JSON.parse(value)
            if (parsed && typeof parsed === "object") {
              for (const [nestedKey, nestedValue] of Object.entries(parsed)) {
                if (
                  shouldCheckKey(nestedKey) &&
                  typeof nestedValue === "string" &&
                  nestedValue.length > 12
                ) {
                  matches.push(nestedValue)
                }
              }
            }
          } catch {
          }
        }
      }

      return matches.find((item) => typeof item === "string") || ""
    })()
  `)

  return typeof token === "string" ? token.trim() : ""
}

async function syncAuthFromLogin(accountId: string) {
  const repo = getRepository()
  const account = await repo.getAccountById(accountId)
  if (!account) {
    return { success: false, message: "账号不存在" }
  }

  const partition = `persist:aah-${account.id}`
  const loginSession = session.fromPartition(partition)
  const loginWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    parent: mainWindow ?? undefined,
    autoHideMenuBar: true,
    title: `登录 - ${account.site_name}`,
    webPreferences: {
      partition,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  installWindowDiagnostics(loginWindow, {
    label: `login:${account.id}`,
  })

  await loginWindow.loadURL(account.site_url)

  return await new Promise<{
    success: boolean
    message: string
    account?: SiteAccount
  }>((resolve) => {
    let finalized = false
    let allowClose = false

    const finalize = async () => {
      if (finalized) return
      finalized = true

      let tokenCandidate = ""
      try {
        tokenCandidate = await extractTokenCandidate(loginWindow, account.site_url)
      } catch {
        tokenCandidate = ""
      }

      const cookies = await loginSession.cookies
        .get({ url: account.site_url })
        .catch(() => [] as Cookie[])
      const cookieHeader = buildCookieHeader(
        cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
        })),
      )

      let nextAccount: SiteAccount = {
        ...account,
        updated_at: Date.now(),
        cookieAuth: cookieHeader ? { sessionCookie: cookieHeader } : account.cookieAuth,
        authType:
          tokenCandidate.trim()
            ? AuthType.AccessToken
            : cookieHeader &&
                (account.authType === AuthType.Cookie ||
                  isAnyrouterSiteType(account.site_type) ||
                  isWongSiteType(account.site_type))
              ? AuthType.Cookie
              : account.authType,
        account_info: {
          ...account.account_info,
          access_token: tokenCandidate.trim() || account.account_info.access_token,
        },
      }

      const synced = await fetchNewApiSelf({ account: nextAccount })
      if (synced) {
        nextAccount = synced
      }

      await repo.saveAccount(nextAccount)

      allowClose = true
      if (!loginWindow.isDestroyed()) {
        loginWindow.close()
      }

      resolve({
        success: true,
        message:
          deriveAccountAuthState(nextAccount) === "needs_login"
            ? "登录窗口已关闭，但未捕获到新的认证信息"
            : "登录会话已同步",
        account: nextAccount,
      })
    }

    loginWindow.on("close", (event) => {
      if (allowClose) {
        return
      }

      event.preventDefault()
      void finalize()
    })
  })
}

async function refreshAccountSnapshot(accountId: string): Promise<SiteAccount> {
  const repo = getRepository()
  const account = await repo.getAccountById(accountId)
  if (!account) {
    throw new Error("账号不存在")
  }

  if (!isSupportedCheckinSiteType(account.site_type)) {
    throw new Error("当前版本暂不支持该站点余额查询")
  }

  if (!hasUsableAuth(account)) {
    throw new Error("缺少可用认证信息，请重新登录后再刷新余额")
  }

  const synced = await fetchNewApiSelf({ account })
  if (!synced) {
    throw new Error("获取站点余额失败，请检查登录状态或站点接口")
  }

  await repo.saveAccount(synced)
  return synced
}

async function refreshAllAccountSnapshots(
  onProgress?: RefreshAllAccountsProgress,
) {
  const repo = getRepository()
  const accounts = await repo.getAccounts()

  let updated = 0
  let failed = 0
  let skipped = 0

  await onProgress?.({
    phase: "started",
    total: accounts.length,
    processed: 0,
    detail:
      accounts.length > 0
        ? `准备刷新 ${accounts.length} 个账号的余额`
        : "当前没有可刷新的账号",
    status: "running",
    updated,
    failed,
    skipped,
  })

  for (const [index, account] of accounts.entries()) {
    await onProgress?.({
      phase: "account_started",
      total: accounts.length,
      processed: index,
      currentAccountId: account.id,
      currentSiteName: account.site_name,
      detail: "正在刷新余额",
      status: "running",
      updated,
      failed,
      skipped,
    })

    if (account.disabled) {
      skipped += 1
      await onProgress?.({
        phase: "account_completed",
        total: accounts.length,
        processed: index + 1,
        currentAccountId: account.id,
        currentSiteName: account.site_name,
        detail: "已跳过：账号已禁用",
        status: "skipped",
        updated,
        failed,
        skipped,
      })
      continue
    }

    if (!isSupportedCheckinSiteType(account.site_type) || !hasUsableAuth(account)) {
      skipped += 1
      await onProgress?.({
        phase: "account_completed",
        total: accounts.length,
        processed: index + 1,
        currentAccountId: account.id,
        currentSiteName: account.site_name,
        detail: "已跳过：站点暂不支持或缺少认证信息",
        status: "skipped",
        updated,
        failed,
        skipped,
      })
      continue
    }

    const synced = await fetchNewApiSelf({ account })
    if (!synced) {
      failed += 1
      await onProgress?.({
        phase: "account_completed",
        total: accounts.length,
        processed: index + 1,
        currentAccountId: account.id,
        currentSiteName: account.site_name,
        detail: "刷新失败，请检查登录状态或站点接口",
        status: "failed",
        updated,
        failed,
        skipped,
      })
      continue
    }

    await repo.saveAccount(synced)
    updated += 1
    await onProgress?.({
      phase: "account_completed",
      total: accounts.length,
      processed: index + 1,
      currentAccountId: account.id,
      currentSiteName: account.site_name,
      detail: "余额已刷新",
      status: "success",
      updated,
      failed,
      skipped,
    })
  }

  await onProgress?.({
    phase: "completed",
    total: accounts.length,
    processed: accounts.length,
    detail: `余额刷新完成：成功 ${updated}，失败 ${failed}，跳过 ${skipped}。`,
    status: failed > 0 ? "failed" : "success",
    updated,
    failed,
    skipped,
  })

  return {
    updated,
    failed,
    skipped,
  }
}

function registerIpcHandlers() {
  ipcMain.handle("app:bootstrap", async () => {
    const repo = getRepository()
    const [accounts, history] = await Promise.all([
      repo.getAccounts(),
      repo.getHistory(),
    ])

    return {
      accounts,
      history,
      dataDirectory: repo.dataDirectory,
    }
  })

  ipcMain.handle("account:save", async (_event, payload: SiteAccount) => {
    const repo = getRepository()
    const existing = payload.id ? await repo.getAccountById(payload.id) : null
    const now = Date.now()

    const nextAccount: SiteAccount = {
      ...payload,
      created_at: existing?.created_at ?? payload.created_at ?? now,
      updated_at: now,
      last_sync_time: payload.last_sync_time ?? existing?.last_sync_time ?? 0,
    }

    return await repo.saveAccount(nextAccount)
  })

  ipcMain.handle("account:delete", async (_event, accountId: string) => {
    return await getRepository().deleteAccount(accountId)
  })

  ipcMain.handle("site:openExternal", async (_event, siteUrl: string) => {
    const url = normalizeExternalUrl(siteUrl)
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle("backup:import", async (_event, providedPath?: string) => {
    let filePath = providedPath?.trim()

    if (!filePath) {
      const options: OpenDialogOptions = {
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      }
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options)

      if (selection.canceled || selection.filePaths.length === 0) {
        return null
      }

      filePath = selection.filePaths[0]
    }

    const fs = await import("node:fs/promises")
    const raw = await fs.readFile(filePath!, "utf8")

    return await importBackupIntoRepository({
      repository: getRepository(),
      raw,
      sourcePath: filePath,
    })
  })

  ipcMain.handle("checkin:run", async (event, accountId?: string | null) => {
    const repo = getRepository()
    const emitProgress =
      accountId == null
        ? createTaskProgressEmitter(event.sender, "checkin-run", "正在批量签到")
        : null
    const firstRun = await executeCheckinRun({
      repository: repo,
      initiatedBy: "desktop",
      mode: "manual",
      targetAccountId: accountId || undefined,
      onProgress: emitProgress
        ? async (progress) => {
            emitProgress(mapCheckinProgress(progress))
          }
        : undefined,
    })

    if (accountId && firstRun.summary.manualActionRequired > 0) {
      await syncAuthFromLogin(accountId)
      return await executeCheckinRun({
        repository: repo,
        initiatedBy: "desktop",
        mode: "manual",
        targetAccountId: accountId,
      })
    }

    return firstRun
  })

  ipcMain.handle("checkin:runBatch", async (event, accountIds: string[]) => {
    const normalizedAccountIds = Array.isArray(accountIds)
      ? accountIds
          .map((accountId) => String(accountId ?? "").trim())
          .filter(Boolean)
      : []

    const emitProgress = createTaskProgressEmitter(
      event.sender,
      "checkin-run",
      "正在批量签到搜索结果",
    )

    return await executeCheckinRun({
      repository: getRepository(),
      initiatedBy: "desktop",
      mode: "manual",
      targetAccountIds: normalizedAccountIds,
      onProgress: async (progress) => {
        emitProgress(mapCheckinProgress(progress))
      },
    })
  })

  ipcMain.handle("account:login", async (_event, accountId: string) => {
    return await syncAuthFromLogin(accountId)
  })

  ipcMain.handle("account:refresh", async (_event, accountId: string) => {
    return await refreshAccountSnapshot(accountId)
  })

  ipcMain.handle("accounts:refresh", async (event: IpcMainInvokeEvent) => {
    const emitProgress = createTaskProgressEmitter(
      event.sender,
      "refresh-accounts",
      "正在刷新全部余额",
    )
    return await refreshAllAccountSnapshots(async (progress) => {
      emitProgress(progress)
    })
  })
}

async function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1200,
    minHeight: 760,
    autoHideMenuBar: true,
    title: "All API Hub Desktop",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  installWindowDiagnostics(window, {
    label: "main",
    showDialogs: true,
    checkBootstrap: true,
  })

  await window.loadFile(rendererIndexPath)
  mainWindow = window
}

async function bootstrap() {
  app.setName("All API Hub Desktop")
  repository = new FileSystemRepository(app.getPath("userData"))
  await repository.initialize()

  registerIpcHandlers()
  await createMainWindow()
}

void app.whenReady().then(bootstrap)

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow()
  }
})
