import type { SiteAccount, StorageRepository } from "@all-api-hub/core"
import { Bot } from "grammy"
import type { UserFromGetMe } from "grammy/types"

import type { ServerConfig } from "../config.js"
import type { GitHubBackupImporter } from "../importing/githubRepoImporter.js"
import type { CheckinExecutionController } from "../localWorker/hybridOrchestrator.js"
import { BusyTaskError, type TaskCoordinator } from "../taskCoordinator.js"
import {
  formatAccountsMessage,
  formatCheckinMessage,
  formatImportMessage,
  formatRefreshMessage,
  formatStatusMessage,
  formatVersionMessage,
} from "./formatting.js"
import {
  formatAccountReferenceCandidates,
  resolveAccountReference,
} from "./accountReference.js"
import { runSingleAccountCheckinWithAuthFallback } from "./accountActions.js"
import { splitTelegramMessage } from "./messageChunks.js"
import { createTaskVerboseLog } from "./taskLog.js"

const TELEGRAM_COMMANDS = [
  { command: "help", description: "显示帮助" },
  { command: "accounts", description: "查看账号列表" },
  { command: "status", description: "查看系统状态" },
  { command: "version", description: "查看版本信息" },
  { command: "sync_import", description: "同步导入账号" },
  { command: "checkin_all", description: "批量签到全部账号" },
  { command: "checkin", description: "单账号签到" },
  { command: "auth_refresh", description: "刷新账号会话" },
  { command: "disable", description: "禁用账号" },
  { command: "enable", description: "启用账号" },
] as const

const TELEGRAM_HELP_LINES = [
  "All API Hub 指令列表：",
  "",
  "/help — 显示本帮助",
  "/accounts — 查看账号列表",
  "/status — 查看系统状态与任务信息",
  "/version — 查看版本与部署信息",
  "/sync_import — 从 GitHub 仓库同步导入账号",
  "/checkin_all — 批量签到全部可签到账号",
  "/checkin <accountId|siteName> [-log] — 单账号签到（-log 输出详细日志）",
  "/auth_refresh <accountId|siteName|all> [-log] — 刷新账号会话（-log 输出详细日志）",
  "/disable <accountId|siteName> — 禁用账号（不再签到和刷新）",
  "/enable <accountId|siteName> — 启用账号",
] as const

export async function createTelegramBot(params: {
  config: ServerConfig
  repository: StorageRepository
  taskCoordinator: TaskCoordinator
  importer: GitHubBackupImporter
  orchestrator: CheckinExecutionController
  botInfo?: UserFromGetMe
  logger: {
    error(error: unknown, message?: string): void
  }
}) {
  const bot = new Bot(
    params.config.telegram.botToken,
    params.botInfo ? { botInfo: params.botInfo } : undefined,
  )

  bot.catch((error) => {
    params.logger.error(error.error, "Telegram bot handler failed")
  })

  const replyText = async (
    reply: (text: string) => Promise<unknown>,
    text: string,
  ) => {
    for (const chunk of splitTelegramMessage(text)) {
      await reply(chunk)
    }
  }

  const sendText = async (
    chatId: number | undefined,
    text: string,
  ) => {
    if (chatId === undefined) {
      return
    }

    await replyText((chunk) => bot.api.sendMessage(chatId, chunk), text)
  }

  bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id ?? "")
    if (
      ctx.chat?.type !== "private" ||
      chatId !== params.config.telegram.adminChatId
    ) {
      await replyText(
        (text) => ctx.reply(text),
        "当前机器人仅允许管理员私聊使用。",
      )
      return
    }

    await next()
  })

  const startTask = async <T>(
    replyPrefix: string,
    kind: string,
    label: string,
    run: () => Promise<T>,
    format: (result: T) => string | Promise<string>,
    reply: (text: string) => Promise<unknown>,
    onError?: (error: unknown) => Promise<void> | void,
  ) => {
    try {
      const task = params.taskCoordinator.startExclusive(kind, label, run)
      await replyText(reply, `${replyPrefix}已开始。`)
      void task
        .then(async (result) => {
          await replyText(reply, await format(result))
        })
        .catch(async (error) => {
          await onError?.(error)
          await replyText(
            reply,
            `任务失败：${error instanceof Error ? error.message : String(error)}`,
          )
        })
      return
    } catch (error) {
      if (error instanceof BusyTaskError) {
        await replyText(reply, error.message)
        return
      }

      throw error
    }
  }

  const handleAccountResolution = async (
    chatId: number | undefined,
    rawInput: string,
    usage: string,
  ): Promise<
    | { status: "resolved"; account: SiteAccount }
    | { status: "handled" }
  > => {
    const input = rawInput.trim()
    if (!input) {
      await sendText(chatId, usage)
      return { status: "handled" }
    }

    const accounts = await params.repository.getAccounts()
    const resolution = resolveAccountReference(accounts, input)
    if (resolution.status === "resolved") {
      return {
        status: "resolved",
        account: resolution.account,
      }
    }

    if (resolution.status === "ambiguous") {
      await sendText(
        chatId,
        [
          `匹配到多个同名账号：${resolution.input}`,
          "请改用 accountId：",
          formatAccountReferenceCandidates(resolution.candidates),
        ].join("\n"),
      )
      return { status: "handled" }
    }

    await sendText(chatId, `未找到账号：${resolution.input}\n${usage}`)
    return { status: "handled" }
  }

  bot.command("help", async (ctx) => {
    const chatId = ctx.chat?.id
    await sendText(chatId, TELEGRAM_HELP_LINES.join("\n"))
  })

  bot.command("sync_import", async (ctx) => {
    const chatId = ctx.chat?.id
    await startTask(
      "同步导入任务",
      "sync_import",
      "从 GitHub 仓库同步账号 JSON",
      () => params.importer.syncFromRepo(),
      (result) => formatImportMessage(result, params.config.timeZone),
      (text) => sendText(chatId, text),
    )
  })

  bot.command("checkin_all", async (ctx) => {
    const chatId = ctx.chat?.id
    await startTask(
      "批量签到任务",
      "checkin_all",
      "执行全部可签到账号",
      () =>
        params.orchestrator.runCheckinBatch({
          mode: "scheduled",
        }),
      (result) => formatCheckinMessage(result, params.config.timeZone),
      (text) => sendText(chatId, text),
    )
  })

  bot.command("checkin", async (ctx) => {
    const chatId = ctx.chat?.id
    const input = ctx.match.trim()
    const verbose = input.includes("-log")
    const cleanInput = input.replace(/-log/gi, "").trim()
    const resolution = await handleAccountResolution(
      chatId,
      cleanInput,
      "用法：/checkin <accountId|siteName> [-log]",
    )
    if (resolution.status !== "resolved") {
      return
    }
    const account = resolution.account
    const verboseLog = verbose
      ? await createTaskVerboseLog({
          diagnosticsDirectory: params.config.diagnosticsDirectory,
          timeZone: params.config.timeZone,
          kind: "checkin-one",
          label: account.site_name,
        })
      : null
    const progressReporter = verbose
      ? async (text: string) => {
          await verboseLog?.append(text)
          await sendText(chatId, text)
        }
      : undefined

    if (verboseLog) {
      await sendText(chatId, `详细日志文件：${verboseLog.filePath}`)
      await verboseLog.append(
        `开始执行单账号签到：${account.site_name} (${account.id})`,
      )
    }

    await startTask(
      `单账号签到任务(${account.site_name})`,
      "checkin_one",
      `执行单账号签到: ${account.site_name} (${account.id})`,
      () =>
        runSingleAccountCheckinWithAuthFallback(account, params.orchestrator, {
          onProgress: progressReporter,
        }),
      async (result) => {
        const message = formatCheckinMessage(result, params.config.timeZone)
        await verboseLog?.append(message)
        return verboseLog ? `${message}\n日志文件：${verboseLog.filePath}` : message
      },
      (text) => sendText(chatId, text),
      (error) =>
        verboseLog?.append(
          `任务失败：${error instanceof Error ? error.message : String(error)}`,
        ),
    )
  })

  bot.command("auth_refresh", async (ctx) => {
    const chatId = ctx.chat?.id
    const input = ctx.match.trim()
    const verbose = input.includes("-log")
    const cleanInput = input.replace(/-log/gi, "").trim()
    let accountId: string | undefined

    if (cleanInput && cleanInput.toLowerCase() !== "all") {
      const resolution = await handleAccountResolution(
        chatId,
        cleanInput,
        "用法：/auth_refresh <accountId|siteName|all> [-log]",
      )
      if (resolution.status !== "resolved") {
        return
      }
      accountId = resolution.account.id
    }

    await startTask(
      "会话刷新任务",
      "auth_refresh",
      accountId ? `刷新账号会话: ${accountId}` : "刷新全部账号会话",
      () =>
        params.orchestrator.refreshSessions(accountId, {
          onProgress: verbose ? (text) => sendText(chatId, text) : undefined,
        }),
      (result) => formatRefreshMessage(result, params.config.timeZone),
      (text) => sendText(chatId, text),
    )
  })

  bot.command("accounts", async (ctx) => {
    const chatId = ctx.chat?.id
    const accounts = await params.repository.getAccounts()
    await sendText(chatId, formatAccountsMessage(accounts))
  })

  bot.command("status", async (ctx) => {
    const chatId = ctx.chat?.id
    const [settings, history, activeLocalWorkerTask] = await Promise.all([
      params.repository.getSettings(),
      params.repository.getHistory(),
      params.orchestrator.getActiveLocalWorkerTask?.() ?? Promise.resolve(null),
    ])

    const displayedTask = activeLocalWorkerTask
      ? {
          active: true,
          kind: `local-worker:${activeLocalWorkerTask.kind}`,
          label: `本地浏览器任务 ${activeLocalWorkerTask.kind} (${activeLocalWorkerTask.status})`,
          startedAt:
            activeLocalWorkerTask.startedAt ??
            activeLocalWorkerTask.claimedAt ??
            activeLocalWorkerTask.requestedAt,
          finishedAt: activeLocalWorkerTask.finishedAt,
        }
      : params.taskCoordinator.getState()

    await sendText(
      chatId,
      formatStatusMessage({
        task: displayedTask,
        latestRecord: history.records[0],
        settings,
        timeZone: params.config.timeZone,
        deploymentVersion: params.config.deploymentVersion,
        appVersion: params.config.appVersion,
        gitCommitShortSha: params.config.gitCommitShortSha,
        gitBranch: params.config.gitBranch,
        gitCommitMessage: params.config.gitCommitMessage,
      }),
    )
  })

  bot.command("version", async (ctx) => {
    const chatId = ctx.chat?.id
    await sendText(
      chatId,
      formatVersionMessage({
        deploymentVersion: params.config.deploymentVersion,
        appVersion: params.config.appVersion,
        gitCommitShortSha: params.config.gitCommitShortSha,
        gitBranch: params.config.gitBranch,
        gitCommitMessage: params.config.gitCommitMessage,
        siteLoginProfilesSource: params.config.siteLoginProfilesSource,
        siteLoginProfilesCount: params.config.siteLoginProfilesCount,
      }),
    )
  })

  bot.command("disable", async (ctx) => {
    const chatId = ctx.chat?.id
    const resolution = await handleAccountResolution(
      chatId,
      ctx.match.trim(),
      "用法：/disable <accountId|siteName>",
    )
    if (resolution.status !== "resolved") {
      return
    }
    const account = resolution.account
    await params.repository.saveAccount({ ...account, disabled: true, updated_at: Date.now() })
    await sendText(chatId, `已禁用：${account.site_name} (${account.id})`)
  })

  bot.command("enable", async (ctx) => {
    const chatId = ctx.chat?.id
    const resolution = await handleAccountResolution(
      chatId,
      ctx.match.trim(),
      "用法：/enable <accountId|siteName>",
    )
    if (resolution.status !== "resolved") {
      return
    }
    const account = resolution.account
    await params.repository.saveAccount({ ...account, disabled: false, updated_at: Date.now() })
    await sendText(chatId, `已启用：${account.site_name} (${account.id})`)
  })

  if (!params.botInfo) {
    await bot.init()
    const adminChatId = Number(params.config.telegram.adminChatId)
    if (Number.isSafeInteger(adminChatId)) {
      try {
        await bot.api.setMyCommands(TELEGRAM_COMMANDS, {
          scope: {
            type: "chat",
            chat_id: adminChatId,
          },
        })
      } catch (error) {
        params.logger.error(error, "Telegram bot command registration failed")
      }
    }
  }

  return bot
}
