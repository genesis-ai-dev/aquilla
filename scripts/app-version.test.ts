import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// The product has one version number. The desktop shell reads it from
// src-tauri/tauri.conf.json (it is also the hot bundle's minShellVersion), the
// web footer bakes the same file in (vite.config.ts), and Cargo.toml and
// package.json carry copies. A copy left behind is how the footer came to say
// v0.1.0 beside a 0.2.3 shell, so a bump that misses one fails here.
const root = path.resolve(import.meta.dirname, "..")
const read = (file: string) => readFileSync(path.join(root, file), "utf8")

describe("app version", () => {
  const shell = (JSON.parse(read("src-tauri/tauri.conf.json")) as { version: string }).version

  it("package.json matches the shell", () => {
    expect((JSON.parse(read("package.json")) as { version: string }).version).toBe(shell)
  })

  it("Cargo.toml matches the shell", () => {
    const cargo = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(read("src-tauri/Cargo.toml"))?.[1]
    expect(cargo).toBe(shell)
  })
})
