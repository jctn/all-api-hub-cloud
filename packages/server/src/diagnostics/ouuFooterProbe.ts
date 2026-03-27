export interface OuuFooterProbeRequest {
  method: string
  url: string
}

export interface OuuFooterProbePageState {
  href: string
  readyState: string
  footerHtml: string | null
  statusFooterHtml: string | null
  hasCustomFooter: boolean
  customFooterHtml: string | null
  hasWarnSvg: boolean
  warnSvgHtml: string | null
  hasWarnScriptTag: boolean
  scriptSources: string[]
  documentCookie: string
  hasSignatureCookie: boolean
  userAgent: string
  webdriver: boolean | null
  platform: string | null
}

export interface OuuFooterProbeResult {
  requests: OuuFooterProbeRequest[]
  page: OuuFooterProbePageState
  screenshotPath?: string
}

export type OuuFooterProbeStage =
  | "footer_html_missing"
  | "custom_footer_not_rendered"
  | "warn_svg_missing"
  | "warn_script_not_injected"
  | "warn_script_injected"

export interface OuuFooterProbeAnalysis {
  stage: OuuFooterProbeStage
  summary: string
}

function hasNewapiwarnRequest(result: OuuFooterProbeResult): boolean {
  return result.requests.some(
    (request) =>
      request.url.includes("/newapiwarn/warnassets/script.js") ||
      request.url.includes("/newapiwarn/login"),
  )
}

export function hasSignatureCookie(documentCookie: string | null | undefined): boolean {
  if (!documentCookie) {
    return false
  }

  return documentCookie
    .split(";")
    .map((entry) => entry.trim())
    .some((entry) => entry.startsWith("signature="))
}

export function analyzeOuuFooterProbe(
  result: OuuFooterProbeResult,
): OuuFooterProbeAnalysis {
  const { page } = result
  const footerHtml = page.footerHtml?.trim() || page.statusFooterHtml?.trim() || ""
  const warnRequestSeen = hasNewapiwarnRequest(result)

  if (!footerHtml) {
    return {
      stage: "footer_html_missing",
      summary:
        "localStorage.footer_html 和 status.footer_html 都为空，说明站点配置层就没有把 newapiwarn 注入入口下发到当前页面。",
    }
  }

  if (!page.hasCustomFooter) {
    return {
      stage: "custom_footer_not_rendered",
      summary:
        "footer_html 已存在，但 .custom-footer 没有渲染出来，断点位于前端页脚组件渲染阶段。",
    }
  }

  if (!page.hasWarnSvg) {
    return {
      stage: "warn_svg_missing",
      summary:
        "custom-footer 已渲染，但隐藏的 newapiwarn SVG 不在 DOM 中，说明 footer_html 没有按预期进入最终节点。",
    }
  }

  if (!page.hasWarnScriptTag && !warnRequestSeen) {
    return {
      stage: "warn_script_not_injected",
      summary:
        "svg[onload] 已存在，但既没有 script 标签也没有 newapiwarn 请求，说明断点位于隐藏 SVG 的 onload 注入阶段。",
    }
  }

  return {
    stage: "warn_script_injected",
    summary:
      "newapiwarn 脚本已经被注入或请求过，后续应继续排查脚本执行、visitorId 生成或 signature 写入阶段。",
  }
}
