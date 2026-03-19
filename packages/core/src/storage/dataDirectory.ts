import os from "node:os"
import path from "node:path"

export const DEFAULT_APP_FOLDER_NAME = "all-api-hub-desktop"

export function resolveDefaultDataDirectory(
  appFolderName = DEFAULT_APP_FOLDER_NAME,
): string {
  const override = process.env.ALL_API_HUB_DATA_DIR?.trim()
  if (override) {
    return path.resolve(override)
  }

  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir()
    return path.join(base, appFolderName)
  }

  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      appFolderName,
    )
  }

  return path.join(os.homedir(), ".config", appFolderName)
}

export function resolveProfilesDirectory(dataDirectory: string): string {
  return path.join(dataDirectory, "profiles")
}
