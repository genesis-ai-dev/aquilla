// Vitest config for the parity run's acceptance + roundtrip suites.
// Mirrors the root test environment (happy-dom + fake-indexeddb setup + @/ alias)
// but includes parity/** (excluded from the default suite) and src/** (so
// parity:score can run the EXCEEDS regression files in the same process).
import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
  },
  test: {
    root: repoRoot,
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
    passWithNoTests: true,
    include: ["parity/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", "e2e/**", "auth-worker/**", "sync-worker/**", "worker/**"],
    testTimeout: 120_000,
  },
})
