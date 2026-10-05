import { describe, expect, it } from "vitest"
import { spawnSync } from "./spawn-command"

describe("spawn command", () => {
  it("launches npx on Windows, where CreateProcess cannot run the .cmd shim", () => {
    const result = spawnSync("npx", ["--version"], { encoding: "utf8" })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(String(result.stdout)).toMatch(/\d+\.\d+\.\d+/)
  })
})
