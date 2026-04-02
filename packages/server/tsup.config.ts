import { defineConfig } from "tsup"

export interface ResolveServerTsupConfigOptions {
  disableDts?: boolean
}

export function resolveServerTsupConfig(
  options: ResolveServerTsupConfigOptions = {},
) {
  return {
    entry: {
      index: "src/index.ts",
      "diagnostics/ouuFooterProbeCli": "src/diagnostics/ouuFooterProbeCli.ts",
    },
    outDir: "dist",
    format: ["esm"] as const,
    clean: true,
    dts: !options.disableDts,
    splitting: false,
  }
}

export default defineConfig(() =>
  resolveServerTsupConfig({
    disableDts: process.env.ALL_API_HUB_DISABLE_SERVER_DTS === "1",
  }),
)
