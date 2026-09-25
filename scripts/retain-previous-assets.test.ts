/**
 * AQU-1405: the deploy-side half of stale-chunk recovery.
 *
 * A tab opened before a deploy keeps asking for the chunk hashes its own
 * index.html names. Publishing only the newest build makes every one of those
 * requests fail the moment a deploy lands (Biblica ETT, four hits in a week),
 * so each deploy carries the previous build's chunks forward for a day.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  ASSET_MANIFEST_PATH,
  RETENTION_MS,
  currentAssetPaths,
  parseAssetManifest,
  reconcileAssetManifest,
  retainPreviousAssets,
} from "./retain-previous-assets.mjs"

const NOW = new Date("2026-09-24T12:00:00.000Z")
const silent = { log: () => {}, warn: () => {} }

function distWith(assets: Record<string, string>): string {
  const dist = mkdtempSync(path.join(tmpdir(), "aqu-1405-"))
  for (const [relative, body] of Object.entries(assets)) {
    const target = path.join(dist, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
  return dist
}

/** A fetch double: known URLs answer 200, everything else 404. */
function fakeFetch(bodies: Record<string, string>) {
  return vi.fn(async (url: string) =>
    url in bodies
      ? { ok: true, status: 200, statusText: "OK", text: async () => bodies[url], arrayBuffer: async () => new TextEncoder().encode(bodies[url]).buffer }
      : { ok: false, status: 404, statusText: "Not Found", text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) },
  ) as unknown as typeof fetch
}

describe("reconcileAssetManifest", () => {
  it("stamps a chunk this build dropped with an expiry a day out", () => {
    const { manifest, restore } = reconcileAssetManifest({
      currentPaths: ["assets/app-chunk-new.js"],
      previous: { assets: [{ path: "assets/app-chunk-old.js", retainUntil: null }] },
      now: NOW,
    })
    expect(restore).toEqual([
      { path: "assets/app-chunk-old.js", retainUntil: new Date(NOW.getTime() + RETENTION_MS).toISOString() },
    ])
    expect(manifest.assets.map((entry) => entry.path)).toEqual([
      "assets/app-chunk-new.js",
      "assets/app-chunk-old.js",
    ])
  })

  it("counts the day from the deploy that superseded the chunk, not from each later deploy", () => {
    const supersededAt = new Date(NOW.getTime() + RETENTION_MS - 60_000).toISOString()
    const { restore } = reconcileAssetManifest({
      currentPaths: ["assets/app-chunk-new.js"],
      previous: { assets: [{ path: "assets/app-chunk-old.js", retainUntil: supersededAt }] },
      now: NOW,
    })
    expect(restore[0].retainUntil).toBe(supersededAt)
  })

  it("drops a retained chunk once its day is up", () => {
    const { manifest, restore } = reconcileAssetManifest({
      currentPaths: ["assets/app-chunk-new.js"],
      previous: {
        assets: [{ path: "assets/app-chunk-ancient.js", retainUntil: new Date(NOW.getTime() - 1).toISOString() }],
      },
      now: NOW,
    })
    expect(restore).toEqual([])
    expect(manifest.assets).toEqual([{ path: "assets/app-chunk-new.js", retainUntil: null }])
  })

  it("re-publishes a still-live chunk as live, with no expiry, even if it was expiring", () => {
    const { manifest, restore } = reconcileAssetManifest({
      currentPaths: ["assets/app-chunk-same.js"],
      previous: { assets: [{ path: "assets/app-chunk-same.js", retainUntil: NOW.toISOString() }] },
      now: NOW,
    })
    expect(restore).toEqual([])
    expect(manifest.assets).toEqual([{ path: "assets/app-chunk-same.js", retainUntil: null }])
  })

  it("never carries forward a non-hashed path — index.html must always be this build's", () => {
    const { manifest, restore } = reconcileAssetManifest({
      currentPaths: ["index.html", "assets/app-chunk-new.js"],
      previous: { assets: [{ path: "index.html", retainUntil: null }] },
      now: NOW,
    })
    expect(restore).toEqual([])
    expect(manifest.assets).toEqual([{ path: "assets/app-chunk-new.js", retainUntil: null }])
  })

  it("ignores manifest entries that try to escape the asset root", () => {
    expect(parseAssetManifest({ assets: [{ path: "assets/../../etc/passwd" }, { path: "/etc/passwd" }] }).assets)
      .toEqual([])
  })

  it("treats a malformed live manifest as no manifest at all", () => {
    expect(parseAssetManifest("<!doctype html>").assets).toEqual([])
    expect(reconcileAssetManifest({ currentPaths: [], previous: "not json", now: NOW }).restore).toEqual([])
  })
})

describe("retainPreviousAssets", () => {
  it("downloads the superseded chunk into dist and publishes a manifest naming both builds", async () => {
    const dist = distWith({ "index.html": "<html>", "assets/app-chunk-new.js": "new()" })
    const fetchImpl = fakeFetch({
      "https://aquilla.app/asset-manifest.json": JSON.stringify({
        schemaVersion: 1,
        assets: [{ path: "assets/app-chunk-old.js", retainUntil: null }],
      }),
      "https://aquilla.app/assets/app-chunk-old.js": "old()",
    })

    const result = await retainPreviousAssets({
      distDir: dist,
      baseUrl: "https://aquilla.app",
      now: NOW,
      fetchImpl,
      log: silent,
    })

    expect(result.restored).toEqual(["assets/app-chunk-old.js"])
    expect(readFileSync(path.join(dist, "assets/app-chunk-old.js"), "utf8")).toBe("old()")
    const published = JSON.parse(readFileSync(path.join(dist, ASSET_MANIFEST_PATH), "utf8")) as {
      assets: { path: string }[]
    }
    expect(published.assets.map((entry) => entry.path)).toEqual([
      "assets/app-chunk-new.js",
      "assets/app-chunk-old.js",
    ])
  })

  it("still writes a manifest — and never throws — when the live site has none yet", async () => {
    const dist = distWith({ "assets/app-chunk-new.js": "new()" })
    const result = await retainPreviousAssets({
      distDir: dist,
      baseUrl: "https://aquilla.app/",
      now: NOW,
      fetchImpl: fakeFetch({}),
      log: silent,
    })
    expect(result.restored).toEqual([])
    expect(result.manifest.assets).toEqual([{ path: "assets/app-chunk-new.js", retainUntil: null }])
  })

  it("does not advertise a chunk it could not fetch back", async () => {
    const dist = distWith({ "assets/app-chunk-new.js": "new()" })
    const result = await retainPreviousAssets({
      distDir: dist,
      baseUrl: "https://aquilla.app",
      now: NOW,
      fetchImpl: fakeFetch({
        "https://aquilla.app/asset-manifest.json": JSON.stringify({
          assets: [{ path: "assets/app-chunk-gone.js", retainUntil: null }],
        }),
      }),
      log: silent,
    })
    expect(result.unavailable).toEqual(["assets/app-chunk-gone.js"])
    expect(result.manifest.assets.map((entry) => entry.path)).toEqual(["assets/app-chunk-new.js"])
  })
})

describe("currentAssetPaths", () => {
  it("lists hashed output with forward slashes and ignores the rest of dist", () => {
    const dist = distWith({ "index.html": "<html>", "assets/app-chunk-a.js": "a", "assets/nested/app-chunk-b.js": "b" })
    expect(currentAssetPaths(dist)).toEqual(["assets/app-chunk-a.js", "assets/nested/app-chunk-b.js"])
  })

  it("is empty for a dist with no assets directory", () => {
    expect(currentAssetPaths(distWith({ "index.html": "<html>" }))).toEqual([])
  })
})
