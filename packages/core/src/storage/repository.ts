import fs from "node:fs/promises"
import path from "node:path"

import {
  type AccountsDocument,
  type AppSettings,
  type CheckinAccountResult,
  type CheckinHistoryDocument,
  type CheckinRunRecord,
  type SiteAccount,
} from "../models/types.js"
import { cloneJson } from "../utils/object.js"
import { JsonFileStore } from "./jsonFileStore.js"

const DEFAULT_ACCOUNTS_DOCUMENT: AccountsDocument = {
  version: 1,
  updatedAt: 0,
  accounts: [],
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  version: 1,
}

const DEFAULT_CHECKIN_HISTORY: CheckinHistoryDocument = {
  version: 1,
  updatedAt: 0,
  records: [],
  accountStates: {},
}

export interface StorageRepository {
  initialize(): Promise<void>
  getAccounts(): Promise<SiteAccount[]>
  getAccountById(accountId: string): Promise<SiteAccount | null>
  replaceAccounts(accounts: SiteAccount[]): Promise<void>
  saveAccount(account: SiteAccount): Promise<SiteAccount>
  deleteAccount(accountId: string): Promise<boolean>
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getHistory(): Promise<CheckinHistoryDocument>
  appendHistory(record: CheckinRunRecord): Promise<CheckinHistoryDocument>
  setLatestAccountResult(
    accountId: string,
    result: Pick<CheckinAccountResult, "status" | "message" | "completedAt">,
  ): Promise<void>
}

export class FileSystemRepository implements StorageRepository {
  private readonly accountsStore: JsonFileStore<AccountsDocument>
  private readonly settingsStore: JsonFileStore<AppSettings>
  private readonly historyStore: JsonFileStore<CheckinHistoryDocument>

  constructor(public readonly dataDirectory: string) {
    this.accountsStore = new JsonFileStore(
      path.join(dataDirectory, "accounts.json"),
      DEFAULT_ACCOUNTS_DOCUMENT,
    )
    this.settingsStore = new JsonFileStore(
      path.join(dataDirectory, "app-settings.json"),
      DEFAULT_APP_SETTINGS,
    )
    this.historyStore = new JsonFileStore(
      path.join(dataDirectory, "checkin-history.json"),
      DEFAULT_CHECKIN_HISTORY,
    )
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDirectory, { recursive: true })
    await Promise.all([
      this.accountsStore.ensureFile(),
      this.settingsStore.ensureFile(),
      this.historyStore.ensureFile(),
    ])
  }

  async getAccounts(): Promise<SiteAccount[]> {
    const document = await this.accountsStore.read()
    return cloneJson(document.accounts)
  }

  async getAccountById(accountId: string): Promise<SiteAccount | null> {
    const accounts = await this.getAccounts()
    return accounts.find((account) => account.id === accountId) ?? null
  }

  async replaceAccounts(accounts: SiteAccount[]): Promise<void> {
    await this.accountsStore.write({
      version: 1,
      updatedAt: Date.now(),
      accounts: cloneJson(accounts),
    })
  }

  async saveAccount(account: SiteAccount): Promise<SiteAccount> {
    const saved = await this.accountsStore.update((current) => {
      const nextAccounts = [...current.accounts]
      const index = nextAccounts.findIndex((item) => item.id === account.id)
      if (index === -1) {
        nextAccounts.push(cloneJson(account))
      } else {
        nextAccounts[index] = cloneJson(account)
      }

      return {
        version: 1,
        updatedAt: Date.now(),
        accounts: nextAccounts,
      }
    })

    return cloneJson(saved.accounts.find((item) => item.id === account.id)!)
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    const before = await this.getAccounts()
    await this.accountsStore.update((current) => ({
      version: 1,
      updatedAt: Date.now(),
      accounts: current.accounts.filter((account) => account.id !== accountId),
    }))

    return before.some((account) => account.id === accountId)
  }

  async getSettings(): Promise<AppSettings> {
    return await this.settingsStore.read()
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return await this.settingsStore.update((current) => ({
      ...current,
      ...cloneJson(patch),
      version: 1,
    }))
  }

  async getHistory(): Promise<CheckinHistoryDocument> {
    return await this.historyStore.read()
  }

  async appendHistory(record: CheckinRunRecord): Promise<CheckinHistoryDocument> {
    return await this.historyStore.update((current) => {
      const nextRecords = [cloneJson(record), ...current.records].slice(0, 100)
      const nextStates = { ...current.accountStates }

      for (const result of record.results) {
        nextStates[result.accountId] = {
          lastRunAt: result.completedAt,
          lastStatus: result.status,
          lastMessage: result.message,
          requiresManualAction: result.status === "manual_action_required",
        }
      }

      return {
        version: 1,
        updatedAt: Date.now(),
        records: nextRecords,
        accountStates: nextStates,
      }
    })
  }

  async setLatestAccountResult(
    accountId: string,
    result: Pick<CheckinAccountResult, "status" | "message" | "completedAt">,
  ): Promise<void> {
    await this.historyStore.update((current) => ({
      ...current,
      updatedAt: Date.now(),
      accountStates: {
        ...current.accountStates,
        [accountId]: {
          lastRunAt: result.completedAt,
          lastStatus: result.status,
          lastMessage: result.message,
          requiresManualAction: result.status === "manual_action_required",
        },
      },
    }))
  }
}
