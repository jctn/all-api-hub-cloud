import { describe, expect, it } from "vitest"

import {
  matchSiteLoginProfile,
  matchOrDefaultSiteLoginProfile,
  parseSiteLoginProfiles,
  requiresLocalBrowserExecution,
} from "../src/auth/siteLoginProfiles.js"

describe("site login profiles", () => {
  it("returns an empty map for missing or blank config", () => {
    expect(parseSiteLoginProfiles(undefined)).toEqual({})
    expect(parseSiteLoginProfiles("")).toEqual({})
    expect(parseSiteLoginProfiles("   ")).toEqual({})
  })

  it("parses host keyed json and applies defaults", () => {
    const profiles = parseSiteLoginProfiles(
      JSON.stringify({
        "demo.example.com": {
          loginButtonSelectors: ["button.login"],
        },
      }),
    )

    expect(profiles["demo.example.com"]).toMatchObject({
      hostname: "demo.example.com",
      loginPath: "/",
      loginButtonSelectors: ["button.login"],
      executionMode: "cloud",
    })
    expect(profiles["demo.example.com"].tokenStorageKeys.length).toBeGreaterThan(0)
    expect(profiles["demo.example.com"]).not.toHaveProperty("localBrowser")
  })

  it("matches exact host and wildcard host", () => {
    const profiles = parseSiteLoginProfiles(
      JSON.stringify({
        "demo.example.com": {
          loginButtonSelectors: ["button.login"],
        },
        "*.shared.example.com": {
          loginButtonSelectors: ["button.shared"],
        },
      }),
    )

    expect(
      matchSiteLoginProfile("https://demo.example.com/console", profiles),
    )?.toMatchObject({
      hostname: "demo.example.com",
    })
    expect(
      matchSiteLoginProfile("https://foo.shared.example.com", profiles),
    )?.toMatchObject({
      hostname: "*.shared.example.com",
    })
  })

  it("supports local-browser execution mode and defaults derived profiles to cloud", () => {
    const profiles = parseSiteLoginProfiles(
      JSON.stringify({
        "demo.example.com": {
          loginButtonSelectors: ["button.login"],
          executionMode: "local-browser",
        },
      }),
    )

    const explicit = matchSiteLoginProfile(
      "https://demo.example.com/console",
      profiles,
    )
    const derived = matchOrDefaultSiteLoginProfile(
      "https://fallback.example.com/console",
      {},
      "new-api",
    )

    expect(explicit?.executionMode).toBe("local-browser")
    expect(requiresLocalBrowserExecution(explicit)).toBe(true)
    expect(derived?.executionMode).toBe("cloud")
    expect(requiresLocalBrowserExecution(derived)).toBe(false)
    expect(requiresLocalBrowserExecution(null)).toBe(false)
  })

  it("parses local browser cloudflare settings without affecting cloud defaults", () => {
    const profiles = parseSiteLoginProfiles(
      JSON.stringify({
        "runanytime.hxi.me": {
          executionMode: "local-browser",
          loginButtonSelectors: ["button.login"],
          localBrowser: {
            cloudflareMode: "prewarm",
            flareSolverrScope: "root",
            flareSolverrTargetPath: "/",
            allowRetryAfterBrowserChallenge: true,
            openRootBeforeCheckin: true,
            manualFallbackPolicy: "disabled",
          },
        },
      }),
    )

    expect(profiles["runanytime.hxi.me"]?.localBrowser).toMatchObject({
      cloudflareMode: "prewarm",
      flareSolverrScope: "root",
      flareSolverrTargetPath: "/",
      allowRetryAfterBrowserChallenge: true,
      openRootBeforeCheckin: true,
      manualFallbackPolicy: "disabled",
      manualFallbackPolicyExplicit: true,
    })
    expect(profiles["runanytime.hxi.me"]?.executionMode).toBe("local-browser")
    expect(profiles["runanytime.hxi.me"]).not.toHaveProperty("cloudflareMode")
  })

  it("defaults local browser cloudflare settings to off unless explicitly enabled", () => {
    const profiles = parseSiteLoginProfiles(
      JSON.stringify({
        "manual.example.com": {
          executionMode: "local-browser",
          loginButtonSelectors: ["button.login"],
          localBrowser: {},
        },
      }),
    )

    expect(profiles["manual.example.com"]?.localBrowser).toMatchObject({
      cloudflareMode: "off",
      flareSolverrScope: "login",
      allowRetryAfterBrowserChallenge: false,
      openRootBeforeCheckin: false,
      manualFallbackPolicy: "last-resort",
      manualFallbackPolicyExplicit: false,
    })
    expect(profiles["manual.example.com"]?.localBrowser).not.toHaveProperty(
      "flareSolverrTargetPath",
    )
    expect(profiles["manual.example.com"]?.executionMode).toBe("local-browser")
    expect(requiresLocalBrowserExecution(profiles["manual.example.com"])).toBe(true)
  })

  it("drops localBrowser settings when execution mode normalizes to cloud", () => {
    const profiles = parseSiteLoginProfiles(
      JSON.stringify({
        "cloud.example.com": {
          executionMode: "unexpected-mode",
          loginButtonSelectors: ["button.login"],
          localBrowser: {
            cloudflareMode: "prewarm",
          },
        },
      }),
    )

    expect(profiles["cloud.example.com"]?.executionMode).toBe("cloud")
    expect(profiles["cloud.example.com"]).not.toHaveProperty("localBrowser")
  })
})
