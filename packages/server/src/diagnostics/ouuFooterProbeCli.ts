import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright"

import { loadServerConfig, resolveServerConfig } from "../config.js"
import {
  analyzeOuuFooterProbe,
  type OuuFooterProbePageState,
  type OuuFooterProbeRequest,
} from "./ouuFooterProbe.js"

const DEFAULT_TARGET_URL = "https://api.ouu.ch/console/personal"
const DEFAULT_WAIT_MS = 8_000
const REQUEST_KEYWORDS = [
  "/api/status",
  "/api/user/self",
  "/newapiwarn/warnassets/script.js",
  "/newapiwarn/login",
  "/cdn-cgi/challenge-platform",
]

function shouldCaptureRequest(url: string): boolean {
  return REQUEST_KEYWORDS.some((keyword) => url.includes(keyword))
}

function resolveTargetUrl(): string {
  return process.env.OUU_PROBE_URL?.trim() || DEFAULT_TARGET_URL
}

function resolveWaitMs(): number {
  const raw = Number.parseInt(process.env.OUU_PROBE_WAIT_MS ?? "", 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_WAIT_MS
}

function buildScreenshotPath(diagnosticsDirectory: string): string {
  return path.join(diagnosticsDirectory, `${Date.now()}-ouu-footer-probe.png`)
}

async function capturePageState(page: import("playwright").Page): Promise<OuuFooterProbePageState> {
  return await page.evaluate(() => {
    const footerHtml = localStorage.getItem("footer_html")
    const statusRaw = localStorage.getItem("status")
    let statusFooterHtml: string | null = null
    try {
      statusFooterHtml = JSON.parse(statusRaw || "{}")?.footer_html ?? null
    } catch {
      statusFooterHtml = null
    }

    const customFooter = document.querySelector(".custom-footer")
    const warnSvg = document.querySelector('svg[onload*="newapiwarn"]')

    return {
      href: location.href,
      readyState: document.readyState,
      footerHtml,
      statusFooterHtml,
      hasCustomFooter: Boolean(customFooter),
      customFooterHtml: customFooter?.innerHTML ?? null,
      hasWarnSvg: Boolean(warnSvg),
      warnSvgHtml: warnSvg?.outerHTML ?? null,
      hasWarnScriptTag: Boolean(
        document.querySelector('script[src*="/newapiwarn/warnassets/script.js"]'),
      ),
      scriptSources: Array.from(document.scripts)
        .map((script) => script.src || "[inline]")
        .slice(0, 20),
      userAgent: navigator.userAgent,
      webdriver:
        typeof navigator.webdriver === "boolean" ? navigator.webdriver : null,
      platform: navigator.platform || null,
    }
  })
}

async function main() {
  const targetUrl = resolveTargetUrl()
  const waitMs = resolveWaitMs()
  const config = await resolveServerConfig(loadServerConfig())

  await mkdir(config.diagnosticsDirectory, { recursive: true })

  const requests: OuuFooterProbeRequest[] = []
  const screenshotPath = buildScreenshotPath(config.diagnosticsDirectory)

  const context = await chromium.launchPersistentContext(
    config.sharedSsoProfileDirectory,
    {
      executablePath: config.chromiumExecutablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      viewport: { width: 1400, height: 960 },
    },
  )

  const page = context.pages()[0] ?? (await context.newPage())

  page.on("request", (request) => {
    const url = request.url()
    if (!shouldCaptureRequest(url)) {
      return
    }
    requests.push({
      method: request.method(),
      url,
    })
  })

  try {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    })
    await page.waitForTimeout(waitMs)

    const pageState = await capturePageState(page)
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined)

    const result = {
      requests,
      page: pageState,
      screenshotPath,
    }

    const analysis = analyzeOuuFooterProbe(result)

    console.log(
      JSON.stringify(
        {
          targetUrl,
          waitedMs: waitMs,
          analysis,
          result,
        },
        null,
        2,
      ),
    )
  } finally {
    await context.close()
  }
}

const entryFile = process.argv[1]
if (entryFile && fileURLToPath(import.meta.url) === path.resolve(entryFile)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
