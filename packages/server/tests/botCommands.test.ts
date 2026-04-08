import { describe, expect, it, vi } from "vitest"

import type { StorageRepository } from "@all-api-hub/core"
import type { UserFromGetMe } from "grammy/types"

import type { ServerConfig } from "../src/config.js"
import { createTelegramBot } from "../src/telegram/bot.js"
import type { CheckinExecutionController } from "../src/checkin/orchestrator.js"
import { TaskCoordinator } from "../src/taskCoordinator.js"

const testBotInfo: UserFromGetMe = {
  id: 123456789,
  is_bot: true,
  first_name: "Test Bot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
}

function createConfig(): ServerConfig {
  return {
    port: 3000,
    databaseUrl: "postgres://user:pass@localhost:5432/all_api_hub",
    dataDirectory: "E:/all-api-hub/tmp",
    diagnosticsDirectory: "E:/all-api-hub/tmp/diagnostics",
    sharedSsoProfileDirectory: "E:/all-api-hub/tmp/profiles/cloud",
    internalAdminToken: "internal-token",
    telegram: {
      botToken: "123456:ABCDEF",
      webhookSecret: "tg-secret",
      adminChatId: "10001",
    },
    importRepo: {
      owner: "owner",
      name: "repo",
      path: "all-api-hub-backup-2026-03-19.json",
      ref: "main",
      githubPat: "pat",
    },
    github: {
      username: "user",
      password: "pass",
      totpSecret: "JBSWY3DPEHPK3PXP",
      linuxdoBaseUrl: "https://linux.do",
    },
    flareSolverrUrl: null,
    siteLoginProfiles: {},
    timeZone: "Asia/Shanghai",
    appVersion: "0.1.0",
    deploymentVersion: "0.1.0+test123",
    gitCommitSha: "test1234567890",
    gitCommitShortSha: "test123",
    gitBranch: "main",
    gitCommitMessage: "Test deployment",
    siteLoginProfilesSource: "github://owner/repo/site-login-profiles.json@main",
    siteLoginProfilesCount: 1,
  }
}

function createPrivateMessageUpdate(text: string, commandLength: number) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: {
        id: 10001,
        type: "private" as const,
      },
      from: {
        id: 10001,
        is_bot: false,
        first_name: "Admin",
      },
      text,
      entities: [
        {
          offset: 0,
          length: commandLength,
          type: "bot_command" as const,
        },
      ],
    },
  }
}

describe("telegram bot commands", () => {
  it("passes force=true to importer when handling /sync_import -force", async () => {
    const syncFromRepo = vi.fn(async () => ({
      skipped: false,
      sha: "sha-1",
      source: "github://owner/repo/all-api-hub-backup-2026-03-19.json@main",
      importedAt: Date.now(),
      result: {
        accounts: [],
        summary: {
          totalAccountNodes: 0,
          importableAccounts: 0,
          checkinCapableAccounts: 0,
          unsupportedAccounts: 0,
          missingFieldAccounts: 0,
          skippedAccounts: 0,
        },
        replacedExistingCount: 0,
      },
    }))
    const bot = await createTelegramBot({
      config: createConfig(),
      repository: {} as StorageRepository,
      taskCoordinator: new TaskCoordinator(),
      importer: { syncFromRepo } as never,
      orchestrator: {
        runCheckinBatch: vi.fn(),
        refreshSessions: vi.fn(),
      } as unknown as CheckinExecutionController,
      botInfo: testBotInfo,
      logger: {
        error: vi.fn(),
      },
    })
    const sendMessage = vi.fn(async () => ({ message_id: 1 }))
    bot.api.sendMessage = sendMessage as typeof bot.api.sendMessage

    await bot.handleUpdate(createPrivateMessageUpdate("/sync_import -force", 12))

    await vi.waitFor(() => {
      expect(syncFromRepo).toHaveBeenCalledWith({ force: true })
    })
  })

  it("shows /sync_import [-force] in help and hides /account_refresh", async () => {
    const bot = await createTelegramBot({
      config: createConfig(),
      repository: {} as StorageRepository,
      taskCoordinator: new TaskCoordinator(),
      importer: {
        syncFromRepo: vi.fn(),
      } as never,
      orchestrator: {
        runCheckinBatch: vi.fn(),
        refreshSessions: vi.fn(),
      } as unknown as CheckinExecutionController,
      botInfo: testBotInfo,
      logger: {
        error: vi.fn(),
      },
    })
    const sendMessage = vi.fn(async () => ({ message_id: 1 }))
    bot.api.sendMessage = sendMessage as typeof bot.api.sendMessage

    await bot.handleUpdate(createPrivateMessageUpdate("/help", 5))

    const helpText = sendMessage.mock.calls.map((call) => String(call[1])).join("\n")
    expect(helpText).toContain("/sync_import [-force] — 从 GitHub 仓库同步导入账号")
    expect(helpText).not.toContain("/account_refresh")
  })
})
