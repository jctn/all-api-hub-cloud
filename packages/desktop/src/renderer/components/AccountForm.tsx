import type { SiteAccount } from "@all-api-hub/core"

import {
  deriveAccountAuthState,
  formatAccountBalanceCny,
  formatAccountBalanceUsd,
  formatAccountLastSyncTime,
  deriveAccountTodayCheckinState,
  deriveAccountSupportState,
  formatAccountLastCheckinDate,
  formatAccountLastDetectedAt,
} from "../utils/accountState"

interface AccountFormProps {
  account: SiteAccount | null
  isExisting: boolean
  busy: boolean
  onChange: (nextAccount: SiteAccount) => void
  onSave: () => void
  onDelete: () => void
  onLogin: () => void
  onCheckin: () => void
  onOpenSite: () => void
  onRefreshBalance: () => void
}

function toNumber(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function AccountForm(props: AccountFormProps) {
  const account = props.account

  if (!account) {
    return (
      <section className="panel account-form-panel empty-state">
        <h2>选择一个账号</h2>
        <p>左侧选择账号，或点击“新增账号”创建新记录。</p>
      </section>
    )
  }

  const authState = deriveAccountAuthState(account)
  const supportState = deriveAccountSupportState(account)
  const todayCheckinState = deriveAccountTodayCheckinState(account)
  const todayCheckinLabel =
    todayCheckinState === "checked_today"
      ? "今日已签到"
      : todayCheckinState === "not_checked_today"
        ? "今日未签到"
        : "当前站点不支持签到"

  return (
    <section className="panel account-form-panel">
      <div className="panel-header">
        <div>
          <h2>{props.isExisting ? "账号详情" : "新增账号"}</h2>
          <p>
            认证状态：
            <strong>
              {authState === "has_access_token"
                ? "已有 Access Token"
                : authState === "has_cookie"
                  ? "已有 Cookie"
                  : "需要重新登录"}
            </strong>
            ，站点支持：
            <strong>{supportState === "supported" ? "支持 v1 签到" : "暂不支持"}</strong>
            ，今日签到：
            <strong>{todayCheckinLabel}</strong>
          </p>
          <div className="detail-status-row">
            <span className="tag">{`当前余额 ${formatAccountBalanceUsd(account)}`}</span>
            <span className="tag">{`约 ${formatAccountBalanceCny(account)}`}</span>
            <span className="tag">{`最近同步 ${formatAccountLastSyncTime(account)}`}</span>
            <span
              className={`tag ${
                todayCheckinState === "checked_today"
                  ? "tag-checkin-today"
                  : todayCheckinState === "not_checked_today"
                    ? "tag-checkin-pending"
                    : "tag-warning"
              }`}
            >
              {todayCheckinLabel}
            </span>
            <span className="tag">上次签到日 {formatAccountLastCheckinDate(account)}</span>
            <span className="tag">最近检测 {formatAccountLastDetectedAt(account)}</span>
          </div>
        </div>
        <div className="actions-row">
          <button
            className="secondary-button"
            onClick={props.onLogin}
            disabled={props.busy || !props.isExisting}
          >
            登录 / 重新登录
          </button>
          <button
            className="secondary-button"
            onClick={props.onRefreshBalance}
            disabled={props.busy || !props.isExisting}
          >
            刷新余额
          </button>
          <button
            className="secondary-button"
            onClick={props.onCheckin}
            disabled={props.busy || !props.isExisting}
          >
            立即签到
          </button>
          <button className="primary-button" onClick={props.onSave} disabled={props.busy}>
            保存账号
          </button>
          {props.isExisting ? (
            <button className="danger-button" onClick={props.onDelete} disabled={props.busy}>
              删除
            </button>
          ) : null}
        </div>
      </div>

      <div className="form-grid">
        <label>
          <span>站点名称</span>
          <input
            value={account.site_name}
            onChange={(event) =>
              props.onChange({ ...account, site_name: event.target.value })
            }
          />
        </label>
        <label>
          <div className="field-label-row">
            <span>站点 URL</span>
            <button
              type="button"
              className="inline-link-button"
              onClick={props.onOpenSite}
              disabled={!account.site_url.trim()}
            >
              打开网站
            </button>
          </div>
          <input
            value={account.site_url}
            onChange={(event) =>
              props.onChange({ ...account, site_url: event.target.value })
            }
          />
        </label>
        <label>
          <span>站点类型</span>
          <input
            list="site-types"
            value={account.site_type}
            onChange={(event) =>
              props.onChange({ ...account, site_type: event.target.value })
            }
          />
          <datalist id="site-types">
            <option value="new-api" />
            <option value="one-api" />
            <option value="one-hub" />
            <option value="done-hub" />
            <option value="anyrouter" />
            <option value="wong-gongyi" />
            <option value="VoAPI" />
            <option value="Super-API" />
            <option value="Rix-Api" />
            <option value="neo-Api" />
          </datalist>
        </label>
        <label>
          <span>认证方式</span>
          <select
            value={account.authType}
            onChange={(event) =>
              props.onChange({
                ...account,
                authType: event.target.value as SiteAccount["authType"],
              })
            }
          >
            <option value="access_token">Access Token</option>
            <option value="cookie">Cookie</option>
            <option value="none">None</option>
          </select>
        </label>
        <label>
          <span>用户 ID</span>
          <input
            type="number"
            value={account.account_info.id}
            onChange={(event) =>
              props.onChange({
                ...account,
                account_info: {
                  ...account.account_info,
                  id: toNumber(event.target.value),
                },
              })
            }
          />
        </label>
        <label>
          <span>用户名</span>
          <input
            value={account.account_info.username}
            onChange={(event) =>
              props.onChange({
                ...account,
                account_info: {
                  ...account.account_info,
                  username: event.target.value,
                },
              })
            }
          />
        </label>
        <label className="span-2">
          <span>Access Token</span>
          <textarea
            rows={3}
            value={account.account_info.access_token}
            onChange={(event) =>
              props.onChange({
                ...account,
                account_info: {
                  ...account.account_info,
                  access_token: event.target.value,
                },
              })
            }
          />
        </label>
        <label className="span-2">
          <span>Cookie Header</span>
          <textarea
            rows={3}
            value={account.cookieAuth?.sessionCookie ?? ""}
            onChange={(event) =>
              props.onChange({
                ...account,
                cookieAuth: event.target.value
                  ? { sessionCookie: event.target.value }
                  : undefined,
              })
            }
          />
        </label>
        <label>
          <span>启用签到检测</span>
          <input
            type="checkbox"
            checked={account.checkIn.enableDetection}
            onChange={(event) =>
              props.onChange({
                ...account,
                checkIn: {
                  ...account.checkIn,
                  enableDetection: event.target.checked,
                },
              })
            }
          />
        </label>
        <label>
          <span>启用自动签到</span>
          <input
            type="checkbox"
            checked={account.checkIn.autoCheckInEnabled !== false}
            onChange={(event) =>
              props.onChange({
                ...account,
                checkIn: {
                  ...account.checkIn,
                  autoCheckInEnabled: event.target.checked,
                },
              })
            }
          />
        </label>
        <label>
          <span>禁用账号</span>
          <input
            type="checkbox"
            checked={account.disabled}
            onChange={(event) =>
              props.onChange({ ...account, disabled: event.target.checked })
            }
          />
        </label>
        <label className="span-2">
          <span>备注</span>
          <textarea
            rows={4}
            value={account.notes}
            onChange={(event) =>
              props.onChange({ ...account, notes: event.target.value })
            }
          />
        </label>
      </div>
    </section>
  )
}
