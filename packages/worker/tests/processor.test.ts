import { describe, expect, it } from "vitest"

import { LocalBrowserTaskProcessor } from "../src/processor.js"
import type { WorkerConfig } from "../src/config.js"
import type { WorkerRuntime } from "../src/runtime.js"

describe("LocalBrowserTaskProcessor", () => {
  it("passes the local runanytime debug root-only switch into the playwright session config", () => {
    const processor = new LocalBrowserTaskProcessor(
      {
        serverUrl: "https://server.example.com",
        workerToken: "worker-token",
        workerId: "local-browser-1",
        privateDataDirectory: "E:/all-api-hub-private-data",
        dataDirectory: "E:/all-api-hub-local-runtime",
        diagnosticsDirectory: "E:/all-api-hub-local-runtime/diagnostics",
        logsDirectory: "E:/all-api-hub-local-runtime/logs",
        profilesDirectory: "E:/all-api-hub-local-runtime/profiles",
        chromiumExecutablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        github: {
          username: "tester",
          password: "secret",
          totpSecret: "JBSWY3DPEHPK3PXP",
          linuxdoBaseUrl: "https://linux.do",
        },
        pollIntervalMs: 15_000,
        heartbeatIntervalMs: 15_000,
        claimTimeoutMs: 45_000,
        heartbeatTimeoutMs: 90_000,
        localFlareSolverr: {
          enabled: false,
          url: null,
          timeoutMs: 90_000,
        },
        runAnytimeDebugRootOnlyPause: true,
      } satisfies WorkerConfig,
      {
        repository: {} as WorkerRuntime["repository"],
        siteLoginProfiles: {},
        paths: {
          dataDirectory: "E:/all-api-hub-local-runtime",
          diagnosticsDirectory: "E:/all-api-hub-local-runtime/diagnostics",
          logsDirectory: "E:/all-api-hub-local-runtime/logs",
          profilesDirectory: "E:/all-api-hub-local-runtime/profiles",
          siteProfilesRoot: "E:/all-api-hub-local-runtime/profiles/sites",
          siteProfileDirectory(accountId: string) {
            return `E:/all-api-hub-local-runtime/profiles/sites/${accountId}`
          },
        },
      } satisfies Pick<WorkerRuntime, "repository" | "siteLoginProfiles" | "paths"> as WorkerRuntime,
    )

    const config = (
      processor as unknown as {
        createLocalSessionConfig: (accountId: string) => {
          runAnytimeDebugRootOnlyPause?: boolean
          sharedSsoProfileDirectory: string
        }
      }
    ).createLocalSessionConfig("acc-1")

    expect(config.runAnytimeDebugRootOnlyPause).toBe(true)
    expect(config.sharedSsoProfileDirectory).toBe(
      "E:/all-api-hub-local-runtime/profiles/sites/acc-1",
    )
  })

  it("keeps the playwright flaresolverr url null when local flaresolverr is disabled", () => {
    const processor = new LocalBrowserTaskProcessor(
      {
        serverUrl: "https://server.example.com",
        workerToken: "worker-token",
        workerId: "local-browser-1",
        privateDataDirectory: "E:/all-api-hub-private-data",
        dataDirectory: "E:/all-api-hub-local-runtime",
        diagnosticsDirectory: "E:/all-api-hub-local-runtime/diagnostics",
        logsDirectory: "E:/all-api-hub-local-runtime/logs",
        profilesDirectory: "E:/all-api-hub-local-runtime/profiles",
        chromiumExecutablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        github: {
          username: "tester",
          password: "secret",
          totpSecret: "JBSWY3DPEHPK3PXP",
          linuxdoBaseUrl: "https://linux.do",
        },
        pollIntervalMs: 15_000,
        heartbeatIntervalMs: 15_000,
        claimTimeoutMs: 45_000,
        heartbeatTimeoutMs: 90_000,
        localFlareSolverr: {
          enabled: false,
          url: "http://127.0.0.1:8191",
          timeoutMs: 90_000,
        },
        runAnytimeDebugRootOnlyPause: false,
      } satisfies WorkerConfig,
      {
        repository: {} as WorkerRuntime["repository"],
        siteLoginProfiles: {},
        paths: {
          dataDirectory: "E:/all-api-hub-local-runtime",
          diagnosticsDirectory: "E:/all-api-hub-local-runtime/diagnostics",
          logsDirectory: "E:/all-api-hub-local-runtime/logs",
          profilesDirectory: "E:/all-api-hub-local-runtime/profiles",
          siteProfilesRoot: "E:/all-api-hub-local-runtime/profiles/sites",
          siteProfileDirectory(accountId: string) {
            return `E:/all-api-hub-local-runtime/profiles/sites/${accountId}`
          },
        },
      } satisfies Pick<WorkerRuntime, "repository" | "siteLoginProfiles" | "paths"> as WorkerRuntime,
    )

    const config = (
      processor as unknown as {
        createLocalSessionConfig: (accountId: string) => {
          flareSolverrUrl: string | null
        }
      }
    ).createLocalSessionConfig("acc-1")

    expect(config.flareSolverrUrl).toBeNull()
  })

  it("passes local flaresolverr settings into the playwright session config", () => {
    const processor = new LocalBrowserTaskProcessor(
      {
        serverUrl: "https://server.example.com",
        workerToken: "worker-token",
        workerId: "local-browser-1",
        privateDataDirectory: "E:/all-api-hub-private-data",
        dataDirectory: "E:/all-api-hub-local-runtime",
        diagnosticsDirectory: "E:/all-api-hub-local-runtime/diagnostics",
        logsDirectory: "E:/all-api-hub-local-runtime/logs",
        profilesDirectory: "E:/all-api-hub-local-runtime/profiles",
        chromiumExecutablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
        github: {
          username: "tester",
          password: "secret",
          totpSecret: "JBSWY3DPEHPK3PXP",
          linuxdoBaseUrl: "https://linux.do",
        },
        pollIntervalMs: 15_000,
        heartbeatIntervalMs: 15_000,
        claimTimeoutMs: 45_000,
        heartbeatTimeoutMs: 90_000,
        localFlareSolverr: {
          enabled: true,
          url: "http://127.0.0.1:8191",
          timeoutMs: 90_000,
        },
        runAnytimeDebugRootOnlyPause: false,
      } satisfies WorkerConfig,
      {
        repository: {} as WorkerRuntime["repository"],
        siteLoginProfiles: {},
        paths: {
          dataDirectory: "E:/all-api-hub-local-runtime",
          diagnosticsDirectory: "E:/all-api-hub-local-runtime/diagnostics",
          logsDirectory: "E:/all-api-hub-local-runtime/logs",
          profilesDirectory: "E:/all-api-hub-local-runtime/profiles",
          siteProfilesRoot: "E:/all-api-hub-local-runtime/profiles/sites",
          siteProfileDirectory(accountId: string) {
            return `E:/all-api-hub-local-runtime/profiles/sites/${accountId}`
          },
        },
      } satisfies Pick<WorkerRuntime, "repository" | "siteLoginProfiles" | "paths"> as WorkerRuntime,
    )

    const config = (
      processor as unknown as {
        createLocalSessionConfig: (accountId: string) => {
          flareSolverrUrl: string | null
          localFlareSolverr?: {
            enabled: boolean
            url: string | null
            timeoutMs: number
          }
        }
      }
    ).createLocalSessionConfig("acc-1")

    expect(config.flareSolverrUrl).toBe("http://127.0.0.1:8191")
    expect(config.localFlareSolverr).toMatchObject({
      enabled: true,
      url: "http://127.0.0.1:8191",
      timeoutMs: 90_000,
    })
  })
})
