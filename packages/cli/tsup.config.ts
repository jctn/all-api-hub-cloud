import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  clean: true,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
})
