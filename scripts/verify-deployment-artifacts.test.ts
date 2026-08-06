import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  assertSafeDeploymentArtifacts,
  findForbiddenDeploymentArtifacts,
  isForbiddenDeploymentArtifactName,
  preparePagesDeploymentArtifacts,
  REQUIRED_ASSET_IGNORE_PATTERNS,
} from "./verify-deployment-artifacts.mjs"

function writeIgnorePolicy(directory: string, patterns = REQUIRED_ASSET_IGNORE_PATTERNS) {
  writeFileSync(join(directory, ".assetsignore"), `${patterns.join("\n")}\n`)
}

describe("deployment artifact metadata guard", () => {
  it.each([
    ".DS_Store",
    "._index.html",
    "Thumbs.db",
    "desktop.ini",
    "ehthumbs.db",
    "__MACOSX",
    ".Spotlight-V100",
    ".Trashes",
    "Icon\r",
  ])("recognizes workstation metadata %j", (name) => {
    expect(isForbiddenDeploymentArtifactName(name)).toBe(true)
  })

  it.each(["index.html", "manifest.json", ".well-known", "_redirects"])(
    "allows deployable artifact %j",
    (name) => {
      expect(isForbiddenDeploymentArtifactName(name)).toBe(false)
    },
  )

  it("accepts a clean artifact tree", () => {
    const directory = mkdtempSync(join(tmpdir(), "aquilla-artifacts-clean-"))
    try {
      mkdirSync(join(directory, "assets"))
      writeIgnorePolicy(directory)
      writeFileSync(join(directory, "index.html"), "<!doctype html>")
      writeFileSync(join(directory, "assets", "app.js"), "export {}")

      expect(findForbiddenDeploymentArtifacts(directory)).toEqual([])
      expect(assertSafeDeploymentArtifacts(directory)).toEqual({ directory, excludedMetadata: [] })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("reports every unsafe relative path in deterministic order", () => {
    const directory = mkdtempSync(join(tmpdir(), "aquilla-artifacts-unsafe-"))
    try {
      mkdirSync(join(directory, "assets"))
      mkdirSync(join(directory, "__MACOSX"))
      writeIgnorePolicy(directory)
      writeFileSync(join(directory, ".DS_Store"), "metadata")
      writeFileSync(join(directory, "assets", "Thumbs.db"), "metadata")

      expect(findForbiddenDeploymentArtifacts(directory)).toEqual([
        ".DS_Store",
        "__MACOSX",
        "assets/Thumbs.db",
      ])
      expect(assertSafeDeploymentArtifacts(directory)).toEqual({
        directory,
        excludedMetadata: [".DS_Store", "__MACOSX", "assets/Thumbs.db"],
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("fails closed when the artifact directory does not exist", () => {
    const directory = join(tmpdir(), `aquilla-artifacts-missing-${crypto.randomUUID()}`)
    expect(() => assertSafeDeploymentArtifacts(directory)).toThrow()
  })

  it("fails closed when the native asset ignore policy is incomplete", () => {
    const directory = mkdtempSync(join(tmpdir(), "aquilla-artifacts-policy-"))
    try {
      writeIgnorePolicy(directory, REQUIRED_ASSET_IGNORE_PATTERNS.slice(1))
      writeFileSync(join(directory, ".DS_Store"), "metadata")

      expect(() => assertSafeDeploymentArtifacts(directory)).toThrow(
        /\.assetsignore is missing required workstation metadata patterns:[\s\S]*\.DS_Store/,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("removes real workstation metadata and the Workers-only policy before a Pages upload", () => {
    const directory = mkdtempSync(join(tmpdir(), "aquilla-pages-artifacts-"))
    try {
      mkdirSync(join(directory, "assets"))
      mkdirSync(join(directory, "__MACOSX"))
      writeIgnorePolicy(directory)
      writeFileSync(join(directory, "index.html"), "<!doctype html>")
      writeFileSync(join(directory, ".DS_Store"), "metadata")
      writeFileSync(join(directory, "assets", "._app.js"), "metadata")

      expect(preparePagesDeploymentArtifacts(directory)).toEqual({
        directory,
        removedMetadata: [".DS_Store", "__MACOSX", "assets/._app.js"],
      })
      expect(findForbiddenDeploymentArtifacts(directory)).toEqual([])
      expect(existsSync(join(directory, ".assetsignore"))).toBe(false)
      expect(existsSync(join(directory, "index.html"))).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
