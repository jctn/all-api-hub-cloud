import { describe, expect, it } from "vitest"

import {
  matchSiteLoginProfile,
  parseSiteLoginProfiles,
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
    })
    expect(profiles["demo.example.com"].tokenStorageKeys.length).toBeGreaterThan(0)
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
})
