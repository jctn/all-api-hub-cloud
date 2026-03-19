import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const desktopRoot = path.resolve(__dirname, "..")

const EXACT_DIRS = new Set(["dist-electron", "dist-renderer", "release"])

function isGeneratedReleaseDirectory(entryName) {
  return entryName === "release" || entryName.startsWith("release-")
}

async function removeDirectory(targetPath) {
  try {
    await fs.rm(targetPath, { recursive: true, force: true })
    console.log(`removed ${path.basename(targetPath)}`)
  } catch (error) {
    if (error && typeof error === "object") {
      const code = "code" in error ? String(error.code) : ""
      if (code === "EPERM" || code === "EBUSY") {
        throw new Error(
          `无法删除 ${targetPath}。请先关闭正在运行的桌面版程序后再重新打包。`,
        )
      }
    }
    throw error
  }
}

async function main() {
  const entries = await fs.readdir(desktopRoot, { withFileTypes: true })
  const targets = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((entryName) => EXACT_DIRS.has(entryName) || isGeneratedReleaseDirectory(entryName))
    .map((entryName) => path.join(desktopRoot, entryName))

  for (const targetPath of targets) {
    await removeDirectory(targetPath)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
