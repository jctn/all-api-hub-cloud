import fs from "node:fs/promises"

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type FileLockOptions = {
  retries?: number
  delayMs?: number
  staleMs?: number
}

type LockMetadata = {
  pid: number
  acquiredAt: number
}

function getErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : ""
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  if (pid === process.pid) {
    return true
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = getErrorCode(error)
    return code === "EPERM"
  }
}

export class FileLock {
  constructor(private readonly lockFilePath: string) {}

  async acquire(options?: FileLockOptions): Promise<void> {
    const retries = options?.retries ?? 100
    const delayMs = options?.delayMs ?? 50
    const staleMs = options?.staleMs ?? 30_000

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const handle = await fs.open(this.lockFilePath, "wx")
        try {
          const metadata: LockMetadata = {
            pid: process.pid,
            acquiredAt: Date.now(),
          }
          await handle.writeFile(JSON.stringify(metadata), "utf8")
        } finally {
          await handle.close()
        }
        return
      } catch (error) {
        const code = getErrorCode(error)

        if (code !== "EEXIST") {
          throw error
        }

        const recovered = await this.removeIfStale(staleMs)
        if (recovered) {
          continue
        }

        if (attempt === retries) {
          throw error
        }
      }

      await delay(delayMs)
    }
  }

  async release(): Promise<void> {
    await fs.rm(this.lockFilePath, { force: true })
  }

  async withLock<T>(
    work: () => Promise<T>,
    options?: FileLockOptions,
  ): Promise<T> {
    await this.acquire(options)

    try {
      return await work()
    } finally {
      await this.release()
    }
  }

  private async removeIfStale(staleMs: number): Promise<boolean> {
    try {
      const stat = await fs.stat(this.lockFilePath)
      const ageMs = Math.max(0, Date.now() - stat.mtimeMs)
      const metadata = await this.readMetadata()
      const ownerAlive =
        metadata && Number.isInteger(metadata.pid) ? isProcessAlive(metadata.pid) : null

      if (ownerAlive === false || ageMs >= staleMs) {
        await this.release()
        return true
      }
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return true
      }
    }

    return false
  }

  private async readMetadata(): Promise<LockMetadata | null> {
    try {
      const raw = await fs.readFile(this.lockFilePath, "utf8")
      if (!raw.trim()) {
        return null
      }

      const parsed = JSON.parse(raw) as Partial<LockMetadata>
      if (
        !Number.isInteger(parsed.pid) ||
        typeof parsed.acquiredAt !== "number" ||
        !Number.isFinite(parsed.acquiredAt)
      ) {
        return null
      }

      return {
        pid: parsed.pid,
        acquiredAt: parsed.acquiredAt,
      }
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null
      }

      return null
    }
  }
}
