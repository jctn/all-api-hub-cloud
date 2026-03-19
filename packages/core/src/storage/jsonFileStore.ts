import fs from "node:fs/promises"
import path from "node:path"

import { cloneJson } from "../utils/object.js"
import { FileLock } from "./fileLock.js"

export class JsonFileStore<TValue> {
  private readonly lock: FileLock

  constructor(
    private readonly filePath: string,
    private readonly defaults: TValue,
  ) {
    this.lock = new FileLock(`${this.filePath}.lock`)
  }

  async ensureFile(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })

    try {
      await fs.access(this.filePath)
    } catch {
      await this.atomicWrite(this.defaults)
    }
  }

  async read(): Promise<TValue> {
    await this.ensureFile()

    try {
      const raw = await fs.readFile(this.filePath, "utf8")
      return raw.trim()
        ? (JSON.parse(raw) as TValue)
        : cloneJson(this.defaults)
    } catch {
      await this.atomicWrite(this.defaults)
      return cloneJson(this.defaults)
    }
  }

  async write(nextValue: TValue): Promise<TValue> {
    await this.ensureFile()
    return await this.lock.withLock(async () => {
      await this.atomicWrite(nextValue)
      return cloneJson(nextValue)
    })
  }

  async update(updater: (current: TValue) => TValue): Promise<TValue> {
    await this.ensureFile()
    return await this.lock.withLock(async () => {
      const current = await this.read()
      const nextValue = updater(current)
      await this.atomicWrite(nextValue)
      return cloneJson(nextValue)
    })
  }

  private async atomicWrite(value: TValue): Promise<void> {
    const tempFilePath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tempFilePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    await fs.rename(tempFilePath, this.filePath)
  }
}
