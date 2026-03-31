import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createTaskVerboseLog } from "../src/telegram/taskLog.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true })
    }),
  )
})

describe("createTaskVerboseLog", () => {
  it("writes timestamped log lines under diagnostics/task-logs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aah-task-log-"))
    tempDirectories.push(directory)

    const log = await createTaskVerboseLog({
      diagnosticsDirectory: directory,
      timeZone: "Asia/Shanghai",
      kind: "checkin-one",
      label: "随时跑路公益站",
    })

    await log.append("first line")
    await log.append("second line")

    const saved = await fs.readFile(log.filePath, "utf8")

    expect(log.filePath).toContain(path.join("task-logs", ""))
    expect(saved).toContain("first line")
    expect(saved).toContain("second line")
  })
})
