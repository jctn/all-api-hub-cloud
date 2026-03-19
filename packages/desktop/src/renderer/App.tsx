import { useEffect, useMemo, useState } from "react"

import type {
  BackupImportResult,
  CheckinHistoryDocument,
  SiteAccount,
} from "@all-api-hub/core"

import type {
  DesktopTaskKind,
  DesktopTaskProgressPayload,
  DesktopTaskProgressStatus,
} from "../shared/taskProgress"
import { AccountForm } from "./components/AccountForm"
import { AccountList } from "./components/AccountList"
import { HistoryPanel } from "./components/HistoryPanel"
import { filterAccountsByQuery } from "./utils/accountSearch"
import { formatAccountBalanceUsd } from "./utils/accountState"

type BusyTaskKind =
  | "import-backup"
  | "refresh-accounts"
  | "checkin-run"
  | "checkin-filtered"
  | "save-account"
  | "delete-account"
  | "login"
  | "checkin-account"
  | "open-site"
  | "refresh-account"

type BusyTaskState = {
  kind: BusyTaskKind
  title: string
}

function createEmptyAccount(): SiteAccount {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    site_name: "",
    site_url: "",
    site_type: "new-api",
    health: { status: "healthy" as SiteAccount["health"]["status"] },
    exchange_rate: 7.2,
    account_info: {
      id: 0,
      access_token: "",
      username: "",
      quota: 0,
      today_prompt_tokens: 0,
      today_completion_tokens: 0,
      today_quota_consumption: 0,
      today_requests_count: 0,
      today_income: 0,
    },
    last_sync_time: 0,
    updated_at: now,
    created_at: now,
    notes: "",
    tagIds: [],
    disabled: false,
    excludeFromTotalBalance: false,
    authType: "access_token" as SiteAccount["authType"],
    checkIn: {
      enableDetection: true,
      autoCheckInEnabled: true,
    },
  }
}

function formatCheckinRunMessage(prefix: string, summary: {
  total: number
  success: number
  alreadyChecked: number
  failed: number
  manualActionRequired: number
  skipped: number
}) {
  return `${prefix}：总计 ${summary.total}，成功 ${summary.success}，已签到 ${summary.alreadyChecked}，失败 ${summary.failed}，需人工处理 ${summary.manualActionRequired}，跳过 ${summary.skipped}。`
}

function formatProgressStatusLabel(status?: DesktopTaskProgressStatus) {
  switch (status) {
    case "running":
      return "进行中"
    case "success":
      return "成功"
    case "already_checked":
      return "已签到"
    case "failed":
      return "失败"
    case "manual_action_required":
      return "需人工处理"
    case "skipped":
      return "已跳过"
    default:
      return "进行中"
  }
}

function describeTaskProgress(
  progress: DesktopTaskProgressPayload | null,
  busyTask: BusyTaskState | null,
) {
  if (progress?.detail?.trim()) {
    return progress.detail
  }

  if (progress?.phase === "completed") {
    return "任务执行完成。"
  }

  if (progress?.currentSiteName) {
    return `正在处理 ${progress.currentSiteName}`
  }

  if (busyTask) {
    return `${busyTask.title}，请稍候。`
  }

  return "任务执行中，请稍候。"
}

function getProgressPercent(progress: DesktopTaskProgressPayload | null) {
  if (!progress || progress.total <= 0) {
    return null
  }

  return Math.max(4, Math.min(100, Math.round((progress.processed / progress.total) * 100)))
}

export function App() {
  const [accounts, setAccounts] = useState<SiteAccount[]>([])
  const [history, setHistory] = useState<CheckinHistoryDocument | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<SiteAccount | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>("")
  const [dataDirectory, setDataDirectory] = useState("")
  const [activeView, setActiveView] = useState<"detail" | "history">("detail")
  const [lastImport, setLastImport] = useState<BackupImportResult | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [busyTask, setBusyTask] = useState<BusyTaskState | null>(null)
  const [taskProgress, setTaskProgress] = useState<DesktopTaskProgressPayload | null>(null)

  const filteredAccounts = useMemo(
    () => filterAccountsByQuery(accounts, searchQuery),
    [accounts, searchQuery],
  )

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedId) ?? null,
    [accounts, selectedId],
  )

  function requireDesktopApi() {
    const api = window.desktopApi
    if (!api) {
      throw new Error("桌面桥接未加载，当前窗口无法访问 Electron preload API。请使用最新打包版本重启应用。")
    }
    return api
  }

  async function refresh() {
    const bootstrap = await requireDesktopApi().bootstrap()
    const visibleAccounts = filterAccountsByQuery(bootstrap.accounts, searchQuery)
    setAccounts(bootstrap.accounts)
    setHistory(bootstrap.history)
    setDataDirectory(bootstrap.dataDirectory)

    if (selectedId) {
      const stillExists = bootstrap.accounts.find((account) => account.id === selectedId)
      if (!stillExists) {
        setSelectedId(visibleAccounts[0]?.id ?? bootstrap.accounts[0]?.id ?? null)
      }
    } else if (bootstrap.accounts[0]) {
      setSelectedId(visibleAccounts[0]?.id ?? bootstrap.accounts[0].id)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const api = window.desktopApi
    if (!api?.onTaskProgress) {
      return
    }

    return api.onTaskProgress((progress) => {
      setTaskProgress(progress)
    })
  }, [])

  useEffect(() => {
    if (selectedAccount) {
      setDraft(selectedAccount)
    } else if (selectedId === "__new__") {
      setDraft(createEmptyAccount())
    } else {
      setDraft(null)
    }
  }, [selectedAccount, selectedId])

  useEffect(() => {
    if (selectedId === "__new__") {
      return
    }

    if (!searchQuery.trim()) {
      return
    }

    if (selectedId && filteredAccounts.some((account) => account.id === selectedId)) {
      return
    }

    setSelectedId(filteredAccounts[0]?.id ?? null)
  }, [filteredAccounts, searchQuery, selectedId])

  async function withBusy(
    work: () => Promise<void>,
    options?: {
      task?: BusyTaskState
      initialProgress?: {
        kind: DesktopTaskKind
        title: string
      }
    },
  ) {
    setBusy(true)
    setBusyTask(options?.task ?? null)
    if (options?.initialProgress) {
      setTaskProgress({
        taskId: `local-${Date.now()}`,
        kind: options.initialProgress.kind,
        title: options.initialProgress.title,
        phase: "started",
        total: 0,
        processed: 0,
        detail: "正在准备任务...",
        status: "running",
      })
    } else {
      setTaskProgress(null)
    }

    try {
      await work()
    } catch (error) {
      const nextMessage =
        error instanceof Error ? error.message : "操作失败，请查看控制台或重新打开应用。"
      console.error("[desktop:renderer] action failed", error)
      setMessage(nextMessage)
    } finally {
      setBusy(false)
      setBusyTask(null)
      setTaskProgress(null)
    }
  }

  const progressPercent = getProgressPercent(taskProgress)
  const progressTitle = taskProgress?.title ?? busyTask?.title ?? "任务执行中"
  const progressDescription = describeTaskProgress(taskProgress, busyTask)
  const isRefreshingAll = busyTask?.kind === "refresh-accounts"
  const isRunningBatchCheckin =
    busyTask?.kind === "checkin-run" || busyTask?.kind === "checkin-filtered"
  const isImportingBackup = busyTask?.kind === "import-backup"

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-copy">
          <p className="eyebrow">All API Hub Desktop</p>
          <h1>精简桌面版</h1>
          <p className="app-subtitle">
            账号管理、JSON 导入、New API / AnyRouter / WONG 签到。数据目录：<code>{dataDirectory}</code>
          </p>
        </div>
        <div className="actions-row app-header-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void withBusy(
                async () => {
                  const result = await requireDesktopApi().importBackup()
                  if (result) {
                    setLastImport(result)
                    setMessage(
                      `导入完成：${result.summary.importableAccounts} 个账号，支持签到 ${result.summary.checkinCapableAccounts} 个。`,
                    )
                    await refresh()
                  }
                },
                {
                  task: {
                    kind: "import-backup",
                    title: "正在导入扩展备份",
                  },
                },
              )
            }
          >
            {isImportingBackup ? "导入中..." : "导入扩展备份"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void withBusy(
                async () => {
                  const result = await requireDesktopApi().refreshAccounts()
                  setMessage(
                    `余额刷新完成：成功 ${result.updated}，失败 ${result.failed}，跳过 ${result.skipped}。`,
                  )
                  await refresh()
                },
                {
                  task: {
                    kind: "refresh-accounts",
                    title: "正在刷新全部余额",
                  },
                  initialProgress: {
                    kind: "refresh-accounts",
                    title: "正在刷新全部余额",
                  },
                },
              )
            }
          >
            {isRefreshingAll ? "刷新中..." : "刷新全部余额"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void withBusy(
                async () => {
                  const run = await requireDesktopApi().runCheckin()
                  setMessage(formatCheckinRunMessage("批量签到完成", run.summary))
                  await refresh()
                  setActiveView("history")
                },
                {
                  task: {
                    kind: "checkin-run",
                    title: "正在批量签到",
                  },
                  initialProgress: {
                    kind: "checkin-run",
                    title: "正在批量签到",
                  },
                },
              )
            }
          >
            {isRunningBatchCheckin ? "签到中..." : "批量签到"}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setActiveView("detail")}
          >
            账号详情
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setActiveView("history")}
          >
            签到记录
          </button>
        </div>
      </header>

      {busyTask || taskProgress ? (
        <section className="task-progress-card">
          <div className="task-progress-header">
            <div>
              <h2>{progressTitle}</h2>
              <p>{progressDescription}</p>
              {taskProgress?.currentSiteName ? (
                <p className="task-progress-current">
                  当前账号：<strong>{taskProgress.currentSiteName}</strong>
                  {taskProgress.status ? (
                    <span className={`tag tag-${taskProgress.status}`}>
                      {formatProgressStatusLabel(taskProgress.status)}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>
            <span className="tag tag-running">
              {taskProgress?.total
                ? `已处理 ${taskProgress.processed} / ${taskProgress.total}`
                : "准备中"}
            </span>
          </div>

          <div
            className={`task-progress-bar ${progressPercent === null ? "indeterminate" : ""}`}
          >
            <div
              className="task-progress-bar-fill"
              style={progressPercent === null ? undefined : { width: `${progressPercent}%` }}
            />
          </div>

          <div className="task-progress-meta">
            <span className="tag tag-running">
              {progressPercent === null ? "正在建立任务上下文" : `进度 ${progressPercent}%`}
            </span>
            {taskProgress?.kind === "refresh-accounts" ? (
              <>
                <span className="tag tag-success">成功 {taskProgress.updated ?? 0}</span>
                <span className="tag tag-failed">失败 {taskProgress.failed ?? 0}</span>
                <span className="tag tag-skipped">跳过 {taskProgress.skipped ?? 0}</span>
              </>
            ) : null}
            {taskProgress?.kind === "checkin-run" ? (
              <>
                <span className="tag tag-success">成功 {taskProgress.success ?? 0}</span>
                <span className="tag tag-already_checked">
                  已签到 {taskProgress.alreadyChecked ?? 0}
                </span>
                <span className="tag tag-failed">失败 {taskProgress.failed ?? 0}</span>
                <span className="tag tag-manual_action_required">
                  人工处理 {taskProgress.manualActionRequired ?? 0}
                </span>
                <span className="tag tag-skipped">跳过 {taskProgress.skipped ?? 0}</span>
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      {message ? <div className="toast-banner">{message}</div> : null}
      {lastImport ? (
        <div className="import-summary">
          <span>导入账号 {lastImport.summary.importableAccounts}</span>
          <span>支持签到 {lastImport.summary.checkinCapableAccounts}</span>
          <span>未支持 {lastImport.summary.unsupportedAccounts}</span>
          <span>缺失字段 {lastImport.summary.missingFieldAccounts}</span>
        </div>
      ) : null}

      <main className="main-layout">
        <AccountList
          accounts={filteredAccounts}
          totalCount={accounts.length}
          selectedId={selectedId === "__new__" ? null : selectedId}
          searchQuery={searchQuery}
          busy={busy}
          onSelect={(accountId) => {
            setSelectedId(accountId)
            setActiveView("detail")
          }}
          onSearchChange={setSearchQuery}
          onRunFilteredCheckin={() =>
            void withBusy(
              async () => {
                const run = await requireDesktopApi().runCheckinBatch(
                  filteredAccounts.map((account) => account.id),
                )
                setMessage(formatCheckinRunMessage("搜索结果批量签到完成", run.summary))
                await refresh()
                setActiveView("history")
              },
              {
                task: {
                  kind: "checkin-filtered",
                  title: "正在批量签到搜索结果",
                },
                initialProgress: {
                  kind: "checkin-run",
                  title: "正在批量签到搜索结果",
                },
              },
            )
          }
          onCreate={() => {
            setSelectedId("__new__")
            setActiveView("detail")
          }}
        />

        <section className="content-column">
          {activeView === "detail" ? (
            <AccountForm
              account={draft}
              isExisting={Boolean(selectedAccount)}
              busy={busy}
              onChange={setDraft}
              onSave={() =>
                void withBusy(
                  async () => {
                    if (!draft) return
                    const saved = await requireDesktopApi().saveAccount(draft)
                    setMessage(`已保存账号：${saved.site_name}`)
                    setSelectedId(saved.id)
                    await refresh()
                  },
                  {
                    task: {
                      kind: "save-account",
                      title: "正在保存账号",
                    },
                  },
                )
              }
              onDelete={() =>
                void withBusy(
                  async () => {
                    if (!selectedAccount) return
                    await requireDesktopApi().deleteAccount(selectedAccount.id)
                    setMessage(`已删除账号：${selectedAccount.site_name}`)
                    setSelectedId(null)
                    await refresh()
                  },
                  {
                    task: {
                      kind: "delete-account",
                      title: "正在删除账号",
                    },
                  },
                )
              }
              onLogin={() =>
                void withBusy(
                  async () => {
                    if (!draft) return
                    const result = await requireDesktopApi().openLogin(draft.id)
                    setMessage(result.message)
                    await refresh()
                  },
                  {
                    task: {
                      kind: "login",
                      title: "正在同步登录会话",
                    },
                  },
                )
              }
              onCheckin={() =>
                void withBusy(
                  async () => {
                    if (!draft) return
                    const run = await requireDesktopApi().runCheckin(draft.id)
                    setMessage(formatCheckinRunMessage("签到完成", run.summary))
                    await refresh()
                    setActiveView("history")
                  },
                  {
                    task: {
                      kind: "checkin-account",
                      title: "正在执行单账号签到",
                    },
                  },
                )
              }
              onOpenSite={() =>
                void withBusy(
                  async () => {
                    if (!draft?.site_url.trim()) {
                      throw new Error("站点 URL 为空，无法打开网站")
                    }
                    await requireDesktopApi().openExternal(draft.site_url)
                  },
                  {
                    task: {
                      kind: "open-site",
                      title: "正在打开站点",
                    },
                  },
                )
              }
              onRefreshBalance={() =>
                void withBusy(
                  async () => {
                    if (!draft) return
                    const refreshed = await requireDesktopApi().refreshAccount(draft.id)
                    setMessage(
                      `余额已刷新：${refreshed.site_name} 当前余额 ${formatAccountBalanceUsd(refreshed)}`,
                    )
                    await refresh()
                  },
                  {
                    task: {
                      kind: "refresh-account",
                      title: "正在刷新当前账号余额",
                    },
                  },
                )
              }
            />
          ) : (
            <HistoryPanel history={history} />
          )}
        </section>
      </main>
    </div>
  )
}
