import { describe, expect, it } from "vitest"

import { loadServerConfig, resolveServerConfig } from "../src/config.js"

const baseEnv = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/all_api_hub",
  INTERNAL_ADMIN_TOKEN: "internal-token",
  LOCAL_WORKER_TOKEN: "local-worker-token",
  TG_BOT_TOKEN: "123456:ABCDEF",
  TG_WEBHOOK_SECRET: "tg-secret",
  TG_ADMIN_CHAT_ID: "10001",
  GITHUB_USERNAME: "user",
  GITHUB_PASSWORD: "pass",
  GITHUB_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
  IMPORT_REPO_OWNER: "jctn",
  IMPORT_REPO_NAME: "all-api-hub-private-data",
  IMPORT_REPO_PATH: "all-api-hub-backup.json",
  IMPORT_REPO_REF: "main",
  IMPORT_GITHUB_PAT: "pat",
  SITE_LOGIN_PROFILES_JSON: "{}",
  TZ: "Asia/Shanghai",
} satisfies NodeJS.ProcessEnv

describe("loadServerConfig", () => {
  it("derives the site login profiles repo from import repo defaults", () => {
    const config = loadServerConfig({
      ...baseEnv,
      SITE_LOGIN_PROFILES_REPO_PATH: "site-login-profiles.json",
    })

    expect(config.siteLoginProfilesRepo).toMatchObject({
      owner: "jctn",
      name: "all-api-hub-private-data",
      path: "site-login-profiles.json",
      ref: "main",
      githubPat: "pat",
    })
  })

  it("allows overriding the site login profiles repo settings", () => {
    const config = loadServerConfig({
      ...baseEnv,
      SITE_LOGIN_PROFILES_REPO_PATH: "profiles/site-login-profiles.json",
      SITE_LOGIN_PROFILES_REPO_OWNER: "custom-owner",
      SITE_LOGIN_PROFILES_REPO_NAME: "custom-repo",
      SITE_LOGIN_PROFILES_REPO_REF: "profiles",
      SITE_LOGIN_PROFILES_GITHUB_PAT: "custom-pat",
    })

    expect(config.siteLoginProfilesRepo).toMatchObject({
      owner: "custom-owner",
      name: "custom-repo",
      path: "profiles/site-login-profiles.json",
      ref: "profiles",
      githubPat: "custom-pat",
    })
  })

  it("derives deployment version and git metadata from environment", () => {
    const config = loadServerConfig({
      ...baseEnv,
      ZEABUR_GIT_BRANCH: "main",
      ZEABUR_GIT_COMMIT_SHA: "1234567890abcdef",
      ZEABUR_GIT_COMMIT_MESSAGE: "Deploy server",
    })

    expect(config.appVersion).toBe("0.1.0")
    expect(config.deploymentVersion).toBe("0.1.0+1234567")
    expect(config.gitCommitSha).toBe("1234567890abcdef")
    expect(config.gitCommitShortSha).toBe("1234567")
    expect(config.gitBranch).toBe("main")
    expect(config.gitCommitMessage).toBe("Deploy server")
    expect(config.siteLoginProfilesSource).toBe("env:SITE_LOGIN_PROFILES_JSON")
    expect(config.siteLoginProfilesCount).toBe(0)
  })
})

describe("resolveServerConfig", () => {
  it("loads site login profiles from a GitHub file when configured", async () => {
    const config = loadServerConfig({
      ...baseEnv,
      SITE_LOGIN_PROFILES_REPO_PATH: "site-login-profiles.json",
    })

    const resolved = await resolveServerConfig(
      config,
      async () =>
        new Response(
          JSON.stringify({
            sha: "sha-1",
            content: Buffer.from(
              JSON.stringify({
                "api.ouu.ch": {
                  loginPath: "/login",
                  loginButtonSelectors: ["button:has-text('使用 LinuxDO 继续')"],
                },
              }),
            ).toString("base64"),
            encoding: "base64",
          }),
          { status: 200 },
        ),
    )

    expect(resolved.siteLoginProfiles["api.ouu.ch"]).toMatchObject({
      hostname: "api.ouu.ch",
      loginPath: "/login",
      loginButtonSelectors: ["button:has-text('使用 LinuxDO 继续')"],
    })
    expect(resolved.siteLoginProfilesSource).toBe(
      "github://jctn/all-api-hub-private-data/site-login-profiles.json@main",
    )
    expect(resolved.siteLoginProfilesCount).toBe(1)
  })
})
