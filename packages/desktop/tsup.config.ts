import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: {
      main: "src/main/index.ts",
    },
    outDir: "dist-electron",
    format: ["esm"],
    clean: true,
    dts: false,
    external: ["electron"],
    splitting: false,
  },
  {
    entry: {
      preload: "src/preload/index.ts",
    },
    outDir: "dist-electron",
    format: ["cjs"],
    clean: false,
    dts: false,
    external: ["electron"],
    splitting: false,
  },
])
