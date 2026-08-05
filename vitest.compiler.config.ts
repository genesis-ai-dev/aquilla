/// <reference types="vitest" />
import path from "path"
import { defineConfig } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"

// One-off config: React Compiler ON even under vitest, to reproduce
// compiler-only memoization bugs (AQU-768). NOT part of the normal suite.
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(__dirname, "./src") }],
  },
  test: {
    root: __dirname,
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/components/cell/CellVoicePanel.assign.test.tsx"],
  },
})
