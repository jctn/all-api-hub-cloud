import type { StorageRepository } from "@all-api-hub/core"
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
} from "./formatting.js"

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

  bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id ?? "")
    if (
      ctx.chat?.type !== "private" ||
      chatId !== params.config.telegram.adminChatId
    ) {
      await ctx.reply("当前机器人仅允许管理员私聊使用。")
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
      const task = await params.taskCoordinator.startExclusive(kind, label, run)
      await reply(`${replyPrefix}已开始。`)
      void task
        .then(async (result) => {
          await reply(format(result))
        })
        .catch(async (error) => {
          await reply(`任务失败：${error instanceof Error ? error.message : String(error)}`)
        })
      return
    } catch (error) {
      if (error instanceof BusyTaskError) {
        await reply(error.message)
        return
      }

      throw error
    }
  }

  bot.command("sync_import", async (ctx) => {
    await startTask(
      "同步导入任务",
      "sync_import",
      "从 GitHub 仓库同步账号 JSON",
      () => params.importer.syncFromRepo(),
      (result) => formatImportMessage(result, params.config.timeZone),
      (text) => ctx.reply(text),
    )
  })

  bot.command("checkin_all", async (ctx) => {
    await startTask(
      "批量签到任务",
      "checkin_all",
      "执行全部可签到账号",
      () =>
        params.orchestrator.runCheckinBatch({
          mode: "scheduled",
        }),
      (result) => formatCheckinMessage(result, params.config.timeZone),
      (text) => ctx.reply(text),
    )
  })

  bot.command("checkin", async (ctx) => {
    const accountId = ctx.match.trim()
    if (!accountId) {
      await ctx.reply("用法：/checkin <accountId>")
      return
    }

    await startTask(
      `单账号签到任务(${accountId})`,
      "checkin_one",
      `执行单账号签到: ${accountId}`,
      () =>
        params.orchestrator.runCheckinBatch({
          accountId,
          mode: "manual",
        }),
      (result) => formatCheckinMessage(result, params.config.timeZone),
      (text) => ctx.reply(text),
    )
  })

  bot.command("auth_refresh", async (ctx) => {
    const input = ctx.match.trim()
    const accountId = !input || input.toLowerCase() === "all" ? undefined : input

    await startTask(
      "会话刷新任务",
      "auth_refresh",
      accountId ? `刷新账号会话: ${accountId}` : "刷新全部账号会话",
      () => params.orchestrator.refreshSessions(accountId),
      (result) => formatRefreshMessage(result, params.config.timeZone),
      (text) => ctx.reply(text),
    )
  })

  bot.command("accounts", async (ctx) => {
    const accounts = await params.repository.getAccounts()
    await ctx.reply(formatAccountsMessage(accounts))
  })

  bot.command("status", async (ctx) => {
    const [settings, history] = await Promise.all([
      params.repository.getSettings(),
      params.repository.getHistory(),
    ])

    await ctx.reply(
      formatStatusMessage({
        task: params.taskCoordinator.getState(),
        latestRecord: history.records[0],
        settings,
        timeZone: params.config.timeZone,
      }),
    )
  })

  if (!params.botInfo) {
    await bot.init()
  }

  return bot
}
