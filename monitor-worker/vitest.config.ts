import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // Pure-logic tests only: the Durable Object and the Worker entry import
    // `cloudflare:workers`, which Node cannot resolve, so they stay untested
    // here and every decision they make lives in the modules under test.
    include: ["test/**/*.test.ts"],
  },
})
