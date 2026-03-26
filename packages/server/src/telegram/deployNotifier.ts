import type { ServerConfig } from "../config.js"

export type RuntimeDeploymentStage = "starting" | "running"

interface DeploymentNotifierLogger {
  error(error: unknown, message?: string): void
}

interface RuntimeDeploymentNotificationOptions {
  config: Pick<
    ServerConfig,
    "telegram" | "timeZone" | "deploymentVersion" | "gitBranch" | "gitCommitShortSha" | "gitCommitMessage"
  >
  stage: RuntimeDeploymentStage
  address?: string
  fetchImpl?: typeof fetch
  logger?: DeploymentNotifierLogger
  timeoutMs?: number
}

const RUNTIME_STAGE_LABELS: Record<RuntimeDeploymentStage, string> = {
  starting: "启动中",
  running: "运行中",
}
const DEPLOYMENT_NOTIFICATION_PREFIX = "[部署通知]"

function formatTimestamp(timeZone: string): string {
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

function resolveServiceName(): string {
  return process.env.ZEABUR_SERVICE_NAME?.trim() || "all-api-hub-server"
}

export function formatRuntimeDeploymentStageMessage(
  options: RuntimeDeploymentNotificationOptions,
): string {
  const lines = [
    DEPLOYMENT_NOTIFICATION_PREFIX,
    `服务: ${resolveServiceName()}`,
    `阶段: ${RUNTIME_STAGE_LABELS[options.stage]}`,
    `版本: ${options.config.deploymentVersion}`,
    `部署: ${(options.config.gitBranch ?? "unknown")}@${options.config.gitCommitShortSha ?? "unknown"}`,
    `时间: ${formatTimestamp(options.config.timeZone)}`,
  ]

  if (options.address) {
    lines.push(`地址: ${options.address}`)
  }

  if (options.config.gitCommitMessage) {
    lines.push(`提交说明: ${options.config.gitCommitMessage}`)
  }

  return lines.join("\n")
}

export async function notifyRuntimeDeploymentStage(
  options: RuntimeDeploymentNotificationOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 2_500
  const text = formatRuntimeDeploymentStageMessage(options)

  try {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${options.config.telegram.botToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: options.config.telegram.adminChatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    )

    if (!response.ok) {
      throw new Error(`Telegram API responded with HTTP ${response.status}`)
    }
  } catch (error) {
    options.logger?.error(
      error,
      `Failed to send deployment stage notification: ${options.stage}`,
    )
  }
}
