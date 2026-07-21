import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // Route-layer tests only — the sandbox client is injected as a fake, so no
    // container/Docker runtime is required (contract §7).
    include: ["test/**/*.test.ts"],
  },
})
