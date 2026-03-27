import { describe, expect, it } from "vitest"

import {
  analyzeOuuFooterProbe,
  type OuuFooterProbeResult,
} from "../src/diagnostics/ouuFooterProbe.js"

function createResult(
  overrides: Partial<OuuFooterProbeResult> = {},
): OuuFooterProbeResult {
  return {
    requests: [],
    page: {
      href: "https://api.ouu.ch/console/personal",
      readyState: "complete",
      footerHtml: null,
      statusFooterHtml: null,
      hasCustomFooter: false,
      customFooterHtml: null,
      hasWarnSvg: false,
      warnSvgHtml: null,
      hasWarnScriptTag: false,
      scriptSources: [],
      userAgent: "HeadlessChrome",
      webdriver: true,
      platform: "Linux x86_64",
    },
    ...overrides,
  }
}

describe("analyzeOuuFooterProbe", () => {
  it("reports missing footer html before any DOM-level diagnosis", () => {
    const analysis = analyzeOuuFooterProbe(createResult())

    expect(analysis.stage).toBe("footer_html_missing")
    expect(analysis.summary).toContain("footer_html")
  })

  it("reports missing warn svg when footer html is present but not rendered into the expected node", () => {
    const analysis = analyzeOuuFooterProbe(
      createResult({
        page: {
          ...createResult().page,
          footerHtml:
            '<svg onload="(function(){var s=document.createElement(\'script\');s.src=\'/newapiwarn/warnassets/script.js\';document.head.appendChild(s);})()"></svg>',
          statusFooterHtml:
            '<svg onload="(function(){var s=document.createElement(\'script\');s.src=\'/newapiwarn/warnassets/script.js\';document.head.appendChild(s);})()"></svg>',
          hasCustomFooter: true,
          customFooterHtml: "<div>footer loaded</div>",
          hasWarnSvg: false,
        },
      }),
    )

    expect(analysis.stage).toBe("warn_svg_missing")
    expect(analysis.summary).toContain("SVG")
  })

  it("reports script injection failure when svg exists but no newapiwarn request or script tag is observed", () => {
    const analysis = analyzeOuuFooterProbe(
      createResult({
        page: {
          ...createResult().page,
          footerHtml:
            '<svg onload="(function(){var s=document.createElement(\'script\');s.src=\'/newapiwarn/warnassets/script.js\';document.head.appendChild(s);})()"></svg>',
          statusFooterHtml:
            '<svg onload="(function(){var s=document.createElement(\'script\');s.src=\'/newapiwarn/warnassets/script.js\';document.head.appendChild(s);})()"></svg>',
          hasCustomFooter: true,
          customFooterHtml:
            '<svg onload="(function(){var s=document.createElement(\'script\');s.src=\'/newapiwarn/warnassets/script.js\';document.head.appendChild(s);})()"></svg>',
          hasWarnSvg: true,
          warnSvgHtml:
            '<svg onload="(function(){var s=document.createElement(\'script\');s.src=\'/newapiwarn/warnassets/script.js\';document.head.appendChild(s);})()"></svg>',
          hasWarnScriptTag: false,
        },
      }),
    )

    expect(analysis.stage).toBe("warn_script_not_injected")
    expect(analysis.summary).toContain("onload")
  })

  it("reports success once the warn script has been injected or requested", () => {
    const analysis = analyzeOuuFooterProbe(
      createResult({
        requests: [
          {
            method: "GET",
            url: "https://api.ouu.ch/newapiwarn/warnassets/script.js",
          },
        ],
        page: {
          ...createResult().page,
          footerHtml:
            '<svg onload="(function(){var s=document.createElement(\'script\');s.src=\'/newapiwarn/warnassets/script.js\';document.head.appendChild(s);})()"></svg>',
          statusFooterHtml:
            '<svg onload="(function(){var s=document.createElement(\'script\');s.src=\'/newapiwarn/warnassets/script.js\';document.head.appendChild(s);})()"></svg>',
          hasCustomFooter: true,
          hasWarnSvg: true,
          hasWarnScriptTag: true,
          scriptSources: ["https://api.ouu.ch/newapiwarn/warnassets/script.js"],
        },
      }),
    )

    expect(analysis.stage).toBe("warn_script_injected")
    expect(analysis.summary).toContain("newapiwarn")
  })
})
