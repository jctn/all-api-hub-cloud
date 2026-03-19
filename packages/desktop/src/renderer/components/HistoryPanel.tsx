import { type CheckinHistoryDocument } from "@all-api-hub/core"

interface HistoryPanelProps {
  history: CheckinHistoryDocument | null
}

export function HistoryPanel(props: HistoryPanelProps) {
  if (!props.history || props.history.records.length === 0) {
    return (
      <section className="panel empty-state">
        <h2>签到记录</h2>
        <p>还没有签到记录。</p>
      </section>
    )
  }

  return (
    <section className="panel history-panel">
      <div className="panel-header">
        <div>
          <h2>签到记录</h2>
          <p>最近 {props.history.records.length} 次运行</p>
        </div>
      </div>

      <div className="history-list">
        {props.history.records.map((record) => (
          <article key={record.id} className="history-card">
            <div className="history-card-header">
              <strong>{new Date(record.completedAt).toLocaleString()}</strong>
              <span className="tag">{record.initiatedBy}</span>
            </div>
            <div className="history-summary">
              <span>总计 {record.summary.total}</span>
              <span>成功 {record.summary.success}</span>
              <span>已签到 {record.summary.alreadyChecked}</span>
              <span>失败 {record.summary.failed}</span>
              <span>需人工处理 {record.summary.manualActionRequired}</span>
              <span>跳过 {record.summary.skipped}</span>
            </div>
            <div className="history-results">
              {record.results.map((result) => (
                <div key={`${record.id}-${result.accountId}`} className="history-result-row">
                  <div>
                    <strong>{result.siteName}</strong>
                    <span>{result.siteUrl}</span>
                  </div>
                  <div className="history-result-meta">
                    <span className={`tag tag-${result.status}`}>{result.status}</span>
                    <span>{result.message}</span>
                  </div>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
