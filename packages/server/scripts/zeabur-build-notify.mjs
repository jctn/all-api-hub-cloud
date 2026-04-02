import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const BUILD_STAGE_LABELS = {
  build_started: "开始构建",
  build_succeeded: "构建成功",
  build_failed: "构建失败",
}
const DEPLOYMENT_NOTIFICATION_PREFIX = "[部署通知]"

function readPackageVersion() {
  try {
    const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url))
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))
    return packageJson.version?.trim() || "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function formatTimestamp(timeZone) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date())
}

function resolveGitMetadata() {
  const gitCommitSha = process.env.ZEABUR_GIT_COMMIT_SHA?.trim() || process.env.GIT_COMMIT_SHA?.trim() || ""
  const gitCommitShortSha = gitCommitSha ? gitCommitSha.slice(0, 7) : ""
  const gitBranch = process.env.ZEABUR_GIT_BRANCH?.trim() || process.env.GIT_BRANCH?.trim() || ""
  const gitCommitMessage =
    process.env.ZEABUR_GIT_COMMIT_MESSAGE?.trim() ||
    process.env.GIT_COMMIT_MESSAGE?.trim() ||
    ""

  return {
    gitBranch,
    gitCommitShortSha,
    gitCommitMessage,
  }
}

export function formatBuildStageMessage(stage, error) {
  const git = resolveGitMetadata()
  const lines = [
    DEPLOYMENT_NOTIFICATION_PREFIX,
    `服务: ${process.env.ZEABUR_SERVICE_NAME?.trim() || "all-api-hub-server"}`,
    `阶段: ${BUILD_STAGE_LABELS[stage]}`,
    `版本: ${readPackageVersion()}${git.gitCommitShortSha ? `+${git.gitCommitShortSha}` : ""}`,
    `部署: ${git.gitBranch || "unknown"}@${git.gitCommitShortSha || "unknown"}`,
    `时间: ${formatTimestamp(process.env.TZ?.trim() || "Asia/Shanghai")}`,
  ]

  if (git.gitCommitMessage) {
    lines.push(`提交说明: ${git.gitCommitMessage}`)
  }

  if (error) {
    lines.push(
      `错误: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return lines.join("\n")
}

async function sendTelegramMessage({ botToken, chatId, text, fetchImpl = fetch, timeoutMs = 2500 }) {
  if (!botToken?.trim() || !chatId?.trim()) {
    throw new Error("Missing TG_BOT_TOKEN or TG_ADMIN_CHAT_ID for build notification")
  }

  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`Telegram API responded with HTTP ${response.status}`)
  }
}

export async function runBuildWithNotifications({ notify, build, logger = console }) {
  const safeNotify = async (stage, error) => {
    try {
      await notify(stage, error)
    } catch (notifyError) {
      logger.warn(
        `[zeabur-build-notify] ${stage} notification failed: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`,
      )
    }
  }

  await safeNotify("build_started")

  try {
    await build()
    await safeNotify("build_succeeded")
  } catch (error) {
    await safeNotify("build_failed", error)
    throw error
  }
}

async function runBuildCommand() {
  const isWindows = process.platform === "win32"
  const command = isWindows ? "npm.cmd" : "npm"
  const cwd = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))
  const runCommand = (args, extraEnv = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: "inherit",
        env: {
          ...process.env,
          ...extraEnv,
        },
        cwd,
      })

      child.once("error", reject)
      child.once("exit", (code) => {
        if (code === 0) {
          resolve()
          return
        }

        reject(new Error(`Command ${args.join(" ")} exited with code ${code ?? "unknown"}`))
      })
    })

  await runCommand(
    [
      "run",
      "build",
      "--workspace",
      "@all-api-hub/core",
      "--workspace",
      "@all-api-hub/browser",
      "--workspace",
      "@all-api-hub/server",
    ],
    {
      ALL_API_HUB_DISABLE_SERVER_DTS: "1",
    },
  )
  await runCommand(["prune", "--omit=dev"])
}

async function main() {
  const botToken = process.env.TG_BOT_TOKEN?.trim() || ""
  const chatId = process.env.TG_ADMIN_CHAT_ID?.trim() || ""

  await runBuildWithNotifications({
    notify: async (stage, error) => {
      await sendTelegramMessage({
        botToken,
        chatId,
        text: formatBuildStageMessage(stage, error),
      })
    },
    build: async () => {
      await runBuildCommand()
    },
  })
}

const entryFile = process.argv[1]
if (entryFile && fileURLToPath(import.meta.url) === path.resolve(entryFile)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
