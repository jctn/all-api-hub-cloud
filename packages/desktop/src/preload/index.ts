import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"

import {
  TASK_PROGRESS_CHANNEL,
  type DesktopTaskProgressPayload,
} from "../shared/taskProgress.js"

contextBridge.exposeInMainWorld("desktopApi", {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  saveAccount: (account: unknown) => ipcRenderer.invoke("account:save", account),
  deleteAccount: (accountId: string) =>
    ipcRenderer.invoke("account:delete", accountId),
  openExternal: (siteUrl: string) =>
    ipcRenderer.invoke("site:openExternal", siteUrl),
  importBackup: (filePath?: string) =>
    ipcRenderer.invoke("backup:import", filePath),
  runCheckin: (accountId?: string | null) =>
    ipcRenderer.invoke("checkin:run", accountId),
  runCheckinBatch: (accountIds: string[]) =>
    ipcRenderer.invoke("checkin:runBatch", accountIds),
  openLogin: (accountId: string) =>
    ipcRenderer.invoke("account:login", accountId),
  refreshAccount: (accountId: string) =>
    ipcRenderer.invoke("account:refresh", accountId),
  refreshAccounts: () => ipcRenderer.invoke("accounts:refresh"),
  onTaskProgress: (listener: (payload: DesktopTaskProgressPayload) => void) => {
    const wrapped = (_event: IpcRendererEvent, payload: DesktopTaskProgressPayload) => {
      listener(payload)
    }

    ipcRenderer.on(TASK_PROGRESS_CHANNEL, wrapped)
    return () => {
      ipcRenderer.off(TASK_PROGRESS_CHANNEL, wrapped)
    }
  },
})
