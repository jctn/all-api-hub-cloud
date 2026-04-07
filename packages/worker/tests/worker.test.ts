import { describe, expect, it } from "vitest"

import * as workerModule from "../src/worker.js"

function getPhaseResolver():
  | ((message: string) => string[])
  | undefined {
  return (workerModule as Record<string, unknown>)
    .resolveObservedPhasesFromProgress as
    | ((message: string) => string[])
    | undefined
}

function getManualActionResolver():
  | ((message: string) => boolean)
  | undefined {
  return (workerModule as Record<string, unknown>)
    .shouldWaitForManualAction as
    | ((message: string) => boolean)
    | undefined
}

describe("resolveObservedPhasesFromProgress", () => {
  it("maps representative progress messages to worker observed phases", () => {
    const resolveObservedPhasesFromProgress = getPhaseResolver()

    expect(resolveObservedPhasesFromProgress).toBeTypeOf("function")
    expect(
      resolveObservedPhasesFromProgress?.("命中本地 FlareSolverr 预热策略"),
    ).toContain("local_prewarm_strategy_hit")
    expect(
      resolveObservedPhasesFromProgress?.("开始本地 FlareSolverr 预热：https://runanytime.hxi.me/"),
    ).toContain("local_flaresolverr_check_start")
    expect(
      resolveObservedPhasesFromProgress?.("本地 FlareSolverr 注入 3 个 challenge cookie"),
    ).toContain("local_prewarm_succeeded")
    expect(
      resolveObservedPhasesFromProgress?.(
        "RunAnytime 根页优先：预热与 cookie 注入后先打开站点根页：https://runanytime.hxi.me/",
      ),
    ).toContain("root_navigation")
    expect(
      resolveObservedPhasesFromProgress?.("完整 SSO 后已同步站点会话，继续页面按钮签到"),
    ).toContain("auto_login_completed")
    expect(
      resolveObservedPhasesFromProgress?.(
        "检测到目标站点已回到 https://runanytime.hxi.me/console，继续后续流程",
      ),
    ).toContain("auto_login_completed")
  })
})

describe("shouldWaitForManualAction", () => {
  it("keeps automatic secondary prewarm progress in running status", () => {
    const shouldWaitForManualAction = getManualActionResolver()

    expect(shouldWaitForManualAction).toBeTypeOf("function")
    expect(
      shouldWaitForManualAction?.("浏览器过程中再次命中 Cloudflare，尝试一次额外预热"),
    ).toBe(false)
    expect(
      shouldWaitForManualAction?.("额外预热完成，刷新当前页面后继续自动流程"),
    ).toBe(false)
  })

  it("only marks explicit manual-handoff prompts as waiting_manual", () => {
    const shouldWaitForManualAction = getManualActionResolver()

    expect(
      shouldWaitForManualAction?.("请在本机浏览器完成 RunAnytime Turnstile 验证"),
    ).toBe(true)
    expect(
      shouldWaitForManualAction?.("登录流程遇到 Cloudflare / Turnstile / CAPTCHA，需人工介入"),
    ).toBe(true)
  })
})
