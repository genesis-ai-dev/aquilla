import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { APP_HTML_INPUTS } from "../vite.config"
import { findMarketingBuildArtifacts } from "./check-app-build"

const temporaryDirectories: string[] = []

function buildDirectory(...entries: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "aquilla-app-build-"))
  temporaryDirectories.push(directory)
  for (const entry of entries) {
    const path = join(directory, entry)
    if (entry === "mkt") mkdirSync(path)
    else writeFileSync(path, "fixture")
  }
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("app build ownership", () => {
  it("configures only the SPA HTML entry", () => {
    expect(APP_HTML_INPUTS).toEqual({ index: resolve("index.html") })
  })

  it("accepts an app-only output directory", () => {
    const directory = buildDirectory("index.html", "google4279c85270b47b1a.html")
    expect(findMarketingBuildArtifacts(directory)).toEqual([])
  })

  it("rejects every legacy marketing artifact", () => {
    const directory = buildDirectory(
      "index.html",
      "homepage.html",
      "beta.html",
      "bible-translation.html",
      "case-study.html",
      "case-study-biblica.html",
      "sitemap.xml",
      "robots.txt",
      "mkt",
    )
    expect(findMarketingBuildArtifacts(directory)).toEqual([
      "beta.html",
      "bible-translation.html",
      "case-study-biblica.html",
      "case-study.html",
      "homepage.html",
      "mkt",
      "robots.txt",
      "sitemap.xml",
    ])
  })
})
