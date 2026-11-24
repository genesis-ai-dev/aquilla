import { spawnSync } from "node:child_process"

// Native smoke tests must not read production accounts or reuse installed-app data.
const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
  stdio: "inherit",
  env: { ...process.env, VITE_AUTH_BASE: "http://127.0.0.1:8788", VITE_CHAT_BASE: "http://127.0.0.1:8788", VITE_SYNC_WORKER_HOST: "127.0.0.1:8787" },
  shell: process.platform === "win32",
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
