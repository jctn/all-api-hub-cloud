import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  clean: true,
  dts: true,
  external: ["@all-api-hub/browser", "@all-api-hub/core", "@all-api-hub/server"],
  splitting: false,
})
