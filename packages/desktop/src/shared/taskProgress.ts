export const TASK_PROGRESS_CHANNEL = "task:progress"

export type DesktopTaskKind = "refresh-accounts" | "checkin-run"

export type DesktopTaskPhase =
  | "started"
  | "account_started"
  | "account_completed"
  | "completed"

export type DesktopTaskProgressStatus =
  | "running"
  | "success"
  | "already_checked"
  | "failed"
  | "manual_action_required"
  | "skipped"

export interface DesktopTaskProgressPayload {
  taskId: string
  kind: DesktopTaskKind
  title: string
  phase: DesktopTaskPhase
  total: number
  processed: number
  currentAccountId?: string
  currentSiteName?: string
  detail?: string
  status?: DesktopTaskProgressStatus
  updated?: number
  success?: number
  alreadyChecked?: number
  failed?: number
  skipped?: number
  manualActionRequired?: number
}
