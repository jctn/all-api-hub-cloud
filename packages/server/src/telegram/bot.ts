import type { SiteAccount, StorageRepository } from "@all-api-hub/core"
import { Bot } from "grammy"
import type { UserFromGetMe } from "grammy/types"

import type { CheckinOrchestrator } from "../checkin/orchestrator.js"
import type { ServerConfig } from "../config.js"
import type { GitHubBackupImporter } from "../importing/githubRepoImporter.js"
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
import { splitTelegramMessage } from "./messageChunks.js"

export async function createTelegramBot(params: {
  config: ServerConfig
  repository: StorageRepository
  taskCoordinator: TaskCoordinator
  importer: GitHubBackupImporter
  orchestrator: CheckinOrchestrator
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
    format: (result: T) => string,
    reply: (text: string) => Promise<unknown>,
  ) => {
    try {
      const task = params.taskCoordinator.startExclusive(kind, label, run)
      await replyText(reply, `${replyPrefix}已开始。`)
      void task
        .then(async (result) => {
          await replyText(reply, format(result))
        })
        .catch(async (error) => {
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
    await sendText(
      chatId,
      [
        "All API Hub 指令列表：",
        "",
        "/help — 显示本帮助",
        "/accounts — 查看账号列表",
        "/status — 查看系统状态与任务信息",
        "/version — 查看版本与部署信息",
        "/sync_import — 从 GitHub 仓库同步导入账号",
        "/checkin_all — 批量签到全部可签到账号",
        "/checkin <accountId|siteName> — 单账号签到",
        "/auth_refresh <accountId|siteName|all> [-log] — 刷新账号会话（-log 输出详细日志）",
        "/disable <accountId|siteName> — 禁用账号（不再签到和刷新）",
        "/enable <accountId|siteName> — 启用账号",
      ].join("\n"),
    )
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
    const resolution = await handleAccountResolution(
      chatId,
      ctx.match.trim(),
      "用法：/checkin <accountId|siteName>",
    )
    if (resolution.status !== "resolved") {
      return
    }
    const account = resolution.account

    await startTask(
      `单账号签到任务(${account.site_name})`,
      "checkin_one",
      `执行单账号签到: ${account.site_name} (${account.id})`,
      () =>
        params.orchestrator.runCheckinBatch({
          accountId: account.id,
          mode: "manual",
        }),
      (result) => formatCheckinMessage(result, params.config.timeZone),
      (text) => sendText(chatId, text),
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
    const [settings, history] = await Promise.all([
      params.repository.getSettings(),
      params.repository.getHistory(),
    ])

    await sendText(
      chatId,
      formatStatusMessage({
        task: params.taskCoordinator.getState(),
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
  }

  return bot
}
