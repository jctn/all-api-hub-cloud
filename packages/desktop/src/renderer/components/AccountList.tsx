import type { SiteAccount } from "@all-api-hub/core"

import {
  deriveAccountAuthState,
  deriveAccountBalanceCny,
  deriveAccountBalanceUsd,
  deriveAccountTodayCheckinState,
  deriveAccountSupportState,
  formatAccountLastSyncTime,
} from "../utils/accountState"

interface AccountListProps {
  accounts: SiteAccount[]
  totalCount: number
  selectedId: string | null
  searchQuery: string
  onSelect: (accountId: string) => void
  onSearchChange: (value: string) => void
  onRunFilteredCheckin: () => void
  busy: boolean
  onCreate: () => void
}

export function AccountList(props: AccountListProps) {
  const summaryLabel =
    props.accounts.length === props.totalCount
      ? `${props.totalCount} 个账号`
      : `显示 ${props.accounts.length} / ${props.totalCount} 个账号`

  return (
    <aside className="panel account-list-panel">
      <div className="panel-header">
        <div>
          <h2>账号列表</h2>
          <p>{summaryLabel}</p>
        </div>
        <button className="primary-button" onClick={props.onCreate}>
          新增账号
        </button>
      </div>

      <div className="account-list-toolbar">
        <input
          className="search-input"
          value={props.searchQuery}
          placeholder="搜索站点名 / URL / 类型 / 用户名 / 备注"
          onChange={(event) => props.onSearchChange(event.target.value)}
        />
        {props.searchQuery.trim() && props.accounts.length > 0 ? (
          <button
            type="button"
            className="secondary-button"
            onClick={props.onRunFilteredCheckin}
            disabled={props.busy}
          >
            签到搜索结果
          </button>
        ) : null}
        {props.searchQuery.trim() ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() => props.onSearchChange("")}
            disabled={props.busy}
          >
            清空
          </button>
        ) : null}
      </div>

      <div className="account-list">
        {props.accounts.length === 0 ? (
          <div className="account-list-empty">
            没有匹配的账号，试试站点名、URL、类型、用户名或备注关键词。
          </div>
        ) : null}

        {props.accounts.map((account) => {
          const authState = deriveAccountAuthState(account)
          const supportState = deriveAccountSupportState(account)
          const todayCheckinState = deriveAccountTodayCheckinState(account)
          const balanceUsd = deriveAccountBalanceUsd(account)
          const balanceCny = deriveAccountBalanceCny(account)

          return (
            <button
              key={account.id}
              className={`account-card ${
                props.selectedId === account.id ? "selected" : ""
              }`}
              onClick={() => props.onSelect(account.id)}
            >
              <div className="account-card-title-row">
                <strong>{account.site_name}</strong>
                <span className={`tag tag-${supportState}`}>
                  {supportState === "supported" ? "支持签到" : "未支持"}
                </span>
              </div>
              <div className="account-card-subtitle">{account.site_url}</div>
              <div className="account-card-balance-row">
                <strong>{`余额 $${balanceUsd.toFixed(2)}`}</strong>
                <span>{`≈ ¥${balanceCny.toFixed(2)}`}</span>
              </div>
              <div className="account-card-caption">{`最近同步 ${formatAccountLastSyncTime(account)}`}</div>
              <div className="account-card-meta">
                <span className="tag">{account.site_type || "unknown"}</span>
                <span className={`tag tag-${authState}`}>
                  {authState === "has_access_token"
                    ? "Token"
                    : authState === "has_cookie"
                      ? "Cookie"
                      : "需登录"}
                </span>
                {todayCheckinState === "checked_today" ? (
                  <span className="tag tag-checkin-today">今日已签到</span>
                ) : null}
                {todayCheckinState === "not_checked_today" ? (
                  <span className="tag tag-checkin-pending">今日未签到</span>
                ) : null}
                {account.disabled ? <span className="tag tag-warning">已禁用</span> : null}
              </div>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
