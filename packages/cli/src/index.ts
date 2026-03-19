import fs from "node:fs/promises"

import {
  executeCheckinRun,
  FileSystemRepository,
  importBackupIntoRepository,
  resolveDefaultDataDirectory,
  deriveAccountAuthState,
  deriveAccountSupportState,
} from "@all-api-hub/core"

function printUsage() {
  console.log(`All API Hub CLI

Usage:
  all-api-hub import <file>
  all-api-hub accounts list
  all-api-hub checkin run [--account <id>]
`)
}

async function getRepository() {
  const repository = new FileSystemRepository(resolveDefaultDataDirectory())
  await repository.initialize()
  return repository
}

async function handleImport(filePath: string) {
  const repository = await getRepository()
  const raw = await fs.readFile(filePath, "utf8")
  const result = await importBackupIntoRepository({
    repository,
    raw,
    sourcePath: filePath,
  })

  console.log(
    `导入完成：${result.summary.importableAccounts} 个账号，支持签到 ${result.summary.checkinCapableAccounts} 个，未支持 ${result.summary.unsupportedAccounts} 个。`,
  )
  console.log(JSON.stringify(result, null, 2))
}

async function handleAccountsList() {
  const repository = await getRepository()
  const accounts = await repository.getAccounts()
  const payload = accounts.map((account) => ({
    id: account.id,
    site_name: account.site_name,
    site_url: account.site_url,
    site_type: account.site_type,
    auth_state: deriveAccountAuthState(account),
    support_state: deriveAccountSupportState(account),
    auto_checkin_enabled: account.checkIn.autoCheckInEnabled !== false,
    checkin_detection_enabled: account.checkIn.enableDetection,
    disabled: account.disabled,
  }))

  console.log(JSON.stringify(payload, null, 2))
}

async function handleCheckinRun(args: string[]) {
  const accountFlagIndex = args.indexOf("--account")
  const targetAccountId =
    accountFlagIndex >= 0 ? args[accountFlagIndex + 1] : undefined

  const repository = await getRepository()
  const record = await executeCheckinRun({
    repository,
    initiatedBy: "cli",
    mode: "scheduled",
    targetAccountId,
  })

  console.log(
    `签到完成：总计 ${record.summary.total}，成功 ${record.summary.success}，已签到 ${record.summary.alreadyChecked}，失败 ${record.summary.failed}，需人工处理 ${record.summary.manualActionRequired}，跳过 ${record.summary.skipped}。`,
  )
  console.log(JSON.stringify(record, null, 2))

  if (record.summary.failed > 0 || record.summary.manualActionRequired > 0) {
    process.exitCode = 1
  }
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    printUsage()
    return
  }

  const [command, subcommand, ...rest] = args

  if (command === "import" && subcommand) {
    await handleImport(subcommand)
    return
  }

  if (command === "accounts" && subcommand === "list") {
    await handleAccountsList()
    return
  }

  if (command === "checkin" && subcommand === "run") {
    await handleCheckinRun(rest)
    return
  }

  printUsage()
  process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
