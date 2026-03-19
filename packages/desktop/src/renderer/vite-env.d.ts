import type {
  BackupImportResult,
  CheckinHistoryDocument,
  CheckinRunRecord,
  SiteAccount,
} from "@all-api-hub/core"
import type { DesktopTaskProgressPayload } from "../shared/taskProgress"

declare global {
  interface Window {
    desktopApi: {
      bootstrap: () => Promise<{
        accounts: SiteAccount[]
        history: CheckinHistoryDocument
        dataDirectory: string
      }>
      saveAccount: (account: SiteAccount) => Promise<SiteAccount>
      deleteAccount: (accountId: string) => Promise<boolean>
      openExternal: (siteUrl: string) => Promise<boolean>
      importBackup: (filePath?: string) => Promise<BackupImportResult | null>
      runCheckin: (accountId?: string | null) => Promise<CheckinRunRecord>
      runCheckinBatch: (accountIds: string[]) => Promise<CheckinRunRecord>
      openLogin: (accountId: string) => Promise<{
        success: boolean
        message: string
        account?: SiteAccount
      }>
      refreshAccount: (accountId: string) => Promise<SiteAccount>
      refreshAccounts: () => Promise<{
        updated: number
        failed: number
        skipped: number
      }>
      onTaskProgress: (
        listener: (payload: DesktopTaskProgressPayload) => void,
      ) => () => void
    }
  }
}

export {}
