import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "diagnostics/ouuFooterProbeCli": "src/diagnostics/ouuFooterProbeCli.ts",
  },
  outDir: "dist",
  format: ["esm"],
  clean: true,
  dts: false,
  splitting: false,
})
