import path from "node:path"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@all-api-hub/core": path.resolve(__dirname, "packages/core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
})
