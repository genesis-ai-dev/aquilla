import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spawnSync } from "./spawn-command"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

describe("spawn command", () => {
  it("launches npx on Windows, where CreateProcess cannot run the .cmd shim", () => {
    const result = spawnSync("npx", ["--version"], { encoding: "utf8" })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(String(result.stdout)).toMatch(/\d+\.\d+\.\d+/)
  })

  it("passes JSON arguments through without a shell re-parse", () => {
    const json = JSON.stringify([{ client_id: "https://chatgpt.com/oauth/client.json" }])
    const result = spawnSync(
      "npx",
      ["tsx", "-e", "process.stdout.write(process.argv[1] ?? '')", json],
      { cwd: REPO_ROOT, encoding: "utf8" },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(json)
  })
})
