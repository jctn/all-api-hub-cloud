import fs from "node:fs/promises"
import path from "node:path"

import { formatTimestamp, sanitizeFileName } from "../utils/text.js"

export interface TaskVerboseLog {
  filePath: string
  append(message: string): Promise<void>
}

export async function createTaskVerboseLog(params: {
  diagnosticsDirectory: string
  timeZone: string
  kind: string
  label?: string
}): Promise<TaskVerboseLog> {
  const directory = path.join(params.diagnosticsDirectory, "task-logs")
  await fs.mkdir(directory, { recursive: true })

  const suffix = params.label ? `-${sanitizeFileName(params.label)}` : ""
  const fileName = `${Date.now()}-${sanitizeFileName(params.kind)}${suffix}.log`
  const filePath = path.join(directory, fileName)

  await fs.writeFile(filePath, "", "utf8")

  return {
    filePath,
    async append(message: string): Promise<void> {
      const line = `[${formatTimestamp(Date.now(), params.timeZone)}] ${message}\n`
      await fs.appendFile(filePath, line, "utf8")
    },
  }
}
