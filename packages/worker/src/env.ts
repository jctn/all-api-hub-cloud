import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export interface LoadWorkerEnvironmentFilesOptions {
  packageDirectory: string
  env?: NodeJS.ProcessEnv
}

const ENV_FILE_NAMES = [".env", ".env.local"] as const

export function resolveWorkerPackageDirectory(
  moduleUrl: string = import.meta.url,
): string {
  const modulePath = fileURLToPath(moduleUrl)
  return path.dirname(path.dirname(modulePath))
}

export function loadWorkerEnvironmentFiles({
  packageDirectory,
  env = process.env,
}: LoadWorkerEnvironmentFilesOptions): void {
  const protectedKeys = new Set(Object.keys(env))

  for (const fileName of ENV_FILE_NAMES) {
    const filePath = path.join(packageDirectory, fileName)
    if (!fs.existsSync(filePath)) {
      continue
    }

    const fileContent = fs.readFileSync(filePath, "utf8")
    applyEnvFileContents(env, fileContent, protectedKeys)
  }
}

function applyEnvFileContents(
  env: NodeJS.ProcessEnv,
  fileContent: string,
  protectedKeys: ReadonlySet<string>,
): void {
  for (const rawLine of fileContent.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const separatorIndex = line.indexOf("=")
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    if (!key || protectedKeys.has(key)) {
      continue
    }

    const rawValue = line.slice(separatorIndex + 1).trim()
    env[key] = stripWrappingQuotes(rawValue)
  }
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) {
    return value
  }

  const first = value[0]
  const last = value[value.length - 1]
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }

  return value
}
