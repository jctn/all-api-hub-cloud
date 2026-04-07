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
