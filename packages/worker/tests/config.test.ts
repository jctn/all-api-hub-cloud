import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  loadWorkerConfig,
  resolveChromiumExecutablePath,
} from "../src/config.js"

describe("loadWorkerConfig", () => {
  it("uses the all-api-hub-worker default runtime directory when ALL_API_HUB_DATA_DIR is not set", () => {
    const config = loadWorkerConfig({
      ALL_API_HUB_SERVER_URL: "https://server.example.com",
      LOCAL_WORKER_TOKEN: "worker-token",
      ALL_API_HUB_PRIVATE_DATA_DIR: "E:/all-api-hub-private-data",
      GITHUB_USERNAME: "tester",
      GITHUB_PASSWORD: "secret",
      GITHUB_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
      LOCALAPPDATA: "C:/Users/Tester/AppData/Local",
    })

    expect(config.dataDirectory).toBe(
      path.join("C:/Users/Tester/AppData/Local", "all-api-hub-worker"),
    )
    expect(config.workerId).toBe("local-browser-1")
    expect(config.pollIntervalMs).toBe(15_000)
    expect(config.runAnytimeDebugRootOnlyPause).toBe(false)
  })

  it("enables the runanytime local debug root-only switch from env", () => {
    const config = loadWorkerConfig({
      ALL_API_HUB_SERVER_URL: "https://server.example.com",
      LOCAL_WORKER_TOKEN: "worker-token",
      ALL_API_HUB_PRIVATE_DATA_DIR: "E:/all-api-hub-private-data",
      GITHUB_USERNAME: "tester",
      GITHUB_PASSWORD: "secret",
      GITHUB_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
      LOCAL_WORKER_DEBUG_RUNANYTIME_ROOT_ONLY: "1",
      LOCALAPPDATA: "C:/Users/Tester/AppData/Local",
    })

    expect(config.runAnytimeDebugRootOnlyPause).toBe(true)
  })

  it("loads local flaresolverr settings for worker mode", () => {
    const config = loadWorkerConfig({
      ALL_API_HUB_SERVER_URL: "https://server.example.com",
      LOCAL_WORKER_TOKEN: "worker-token",
      ALL_API_HUB_PRIVATE_DATA_DIR: "E:/all-api-hub-private-data",
      GITHUB_USERNAME: "tester",
      GITHUB_PASSWORD: "secret",
      GITHUB_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
      LOCAL_FLARESOLVERR_ENABLED: "true",
      LOCAL_FLARESOLVERR_URL: "http://127.0.0.1:8191",
      LOCAL_FLARESOLVERR_TIMEOUT_MS: "90000",
      LOCALAPPDATA: "C:/Users/Tester/AppData/Local",
    })

    expect(config.localFlareSolverr).toMatchObject({
      enabled: true,
      url: "http://127.0.0.1:8191",
      timeoutMs: 90_000,
    })
  })
})

describe("resolveChromiumExecutablePath", () => {
  it("auto-detects a locally installed Chrome on Windows when CHROMIUM_PATH is not set", () => {
    const executablePath = resolveChromiumExecutablePath(
      {},
      {
        platform: "win32",
        pathExists: (candidatePath) =>
          candidatePath === "C:/Program Files/Google/Chrome/Application/chrome.exe",
      },
    )

    expect(executablePath).toBe(
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    )
  })

  it("prefers explicit CHROMIUM_PATH over auto-detected browser paths", () => {
    const executablePath = resolveChromiumExecutablePath(
      {
        CHROMIUM_PATH: "D:/Portable/Chrome/chrome.exe",
      },
      {
        platform: "win32",
        pathExists: () => true,
      },
    )

    expect(executablePath).toBe("D:/Portable/Chrome/chrome.exe")
  })
})
