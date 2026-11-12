import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { APP_HTML_INPUTS } from "../vite.config"
import {
  WORKERS_ASSET_SIZE_LIMIT_BYTES,
  findMarketingBuildArtifacts,
  findOversizedAssets,
} from "./check-app-build"

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

describe("app build asset sizes", () => {
  /** A file of exactly `bytes` — sparse, so the 25 MiB cases cost no disk. */
  function assetOfSize(directory: string, name: string, bytes: number): void {
    const path = join(directory, name)
    writeFileSync(path, "")
    truncateSync(path, bytes)
  }

  it("uses the Cloudflare Workers per-asset limit", () => {
    expect(WORKERS_ASSET_SIZE_LIMIT_BYTES).toBe(25 * 1024 * 1024)
  })

  it("accepts an asset that is exactly at the limit", () => {
    const directory = buildDirectory("index.html")
    mkdirSync(join(directory, "assets"))
    assetOfSize(directory, "assets/ort-wasm-simd-threaded.wasm", WORKERS_ASSET_SIZE_LIMIT_BYTES)
    expect(findOversizedAssets(directory)).toEqual([])
  })

  it("rejects an asset over the limit, wherever it sits in the output", () => {
    const directory = buildDirectory("index.html")
    mkdirSync(join(directory, "assets"))
    assetOfSize(directory, "assets/small.wasm", 1024)
    assetOfSize(directory, "assets/ort-wasm-simd-threaded.asyncify.wasm", WORKERS_ASSET_SIZE_LIMIT_BYTES + 1)
    assetOfSize(directory, "big-root.bin", WORKERS_ASSET_SIZE_LIMIT_BYTES + 2)
    expect(findOversizedAssets(directory)).toEqual([
      { path: "assets/ort-wasm-simd-threaded.asyncify.wasm", bytes: WORKERS_ASSET_SIZE_LIMIT_BYTES + 1 },
      { path: "big-root.bin", bytes: WORKERS_ASSET_SIZE_LIMIT_BYTES + 2 },
    ])
  })
})
