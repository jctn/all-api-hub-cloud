import { CheckinResultStatus } from "@all-api-hub/core"
import { describe, expect, it } from "vitest"

import {
  formatAccountRefreshMessage,
  formatCheckinMessage,
} from "../src/telegram/formatting.js"

describe("formatCheckinMessage", () => {
  it("renders per-account details and reward hints", () => {
    const message = formatCheckinMessage(
      {
        refreshedAccountIds: ["acc-1"],
        record: {
          id: "run-1",
          initiatedBy: "server",
          targetAccountIds: null,
          startedAt: 1_710_000_000_000,
          completedAt: 1_710_000_060_000,
          summary: {
            total: 3,
            success: 1,
            alreadyChecked: 1,
            failed: 1,
            manualActionRequired: 0,
            skipped: 0,
          },
          results: [
            {
              accountId: "acc-1",
              siteName: "Alpha API",
              siteUrl: "https://alpha.example.com",
              siteType: "new-api",
              status: CheckinResultStatus.Success,
              message: "签到成功，获得 0.5 刀，今日收入 +1 刀",
              startedAt: 1,
              completedAt: 2,
            },
            {
              accountId: "acc-2",
              siteName: "Beta API",
              siteUrl: "https://beta.example.com",
              siteType: "new-api",
              status: CheckinResultStatus.AlreadyChecked,
              message: "今天已经签到，今日收入 +1 刀",
              startedAt: 3,
              completedAt: 4,
            },
            {
              accountId: "acc-3",
              siteName: "Gamma API",
              siteUrl: "https://gamma.example.com",
              siteType: "new-api",
              status: CheckinResultStatus.Failed,
              message: "认证失效，请重新登录",
              startedAt: 5,
              completedAt: 6,
            },
          ],
        },
      },
      "Asia/Shanghai",
    )

    expect(message).toContain("账号明细:")
    expect(message).toContain("\"Alpha API\"，签到情况：签到成功（获得 0.5 刀；今日收入 +1 刀）；已自动续期会话")
    expect(message).toContain("\"Beta API\"，签到情况：已签到（今日收入 +1 刀）")
    expect(message).toContain("\"Gamma API\"，签到情况：签到失败；失败原因：认证失效，请重新登录")
  })
})

describe("formatAccountRefreshMessage", () => {
  it("renders summary and only lists non-updated account details", () => {
    const message = formatAccountRefreshMessage(
      {
        startedAt: 1_710_000_000_000,
        completedAt: 1_710_000_060_000,
        summary: {
          total: 3,
          updated: 1,
          failed: 1,
          skipped: 1,
        },
        results: [
          {
            accountId: "acc-1",
            siteName: "Alpha API",
            status: "updated",
            message: "账号数据已刷新",
          },
          {
            accountId: "acc-2",
            siteName: "Beta API",
            status: "failed",
            message: "刷新失败，请检查登录状态或站点接口",
          },
          {
            accountId: "acc-3",
            siteName: "Gamma API",
            status: "skipped",
            message: "已跳过：缺少可用认证信息",
          },
        ],
      },
      "Asia/Shanghai",
    )

    expect(message).toContain("账号数据刷新完成。")
    expect(message).toContain("updated=1 failed=1 skipped=1")
    expect(message).toContain("- Beta API: 刷新失败，请检查登录状态或站点接口")
    expect(message).toContain("- Gamma API: 已跳过：缺少可用认证信息")
    expect(message).not.toContain("Alpha API")
  })
})
