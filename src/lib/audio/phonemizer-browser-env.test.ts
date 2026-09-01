import { afterEach, describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  ensureArrayToSorted,
  ensureBrowserPhonemizerEnv,
  ensureReadableStreamAsyncIterator,
  friendlyKokoroError,
  patchPhonemizerBrowserUnpack,
  stripNodeVersionMarker,
} from "./phonemizer-browser-env"

function shippedPhonemizerSource(): string {
  const pnpm = path.resolve(import.meta.dirname, "../../../node_modules/.pnpm")
  const dir = readdirSync(pnpm).find((name) => name.startsWith("phonemizer@"))
  if (!dir) throw new Error("phonemizer is not installed")
  return readFileSync(path.join(pnpm, dir, "node_modules/phonemizer/dist/phonemizer.js"), "utf8")
}

describe("stripNodeVersionMarker", () => {
  it("removes process.versions.node so phonemizer takes the browser data path", () => {
    const versions: { node?: string } = { node: "18.20.0" }
    stripNodeVersionMarker(versions)
    expect(versions.node).toBeUndefined()
  })

  it("is a no-op when the marker is already absent", () => {
    const versions: { node?: string } = {}
    stripNodeVersionMarker(versions)
    expect(versions.node).toBeUndefined()
    stripNodeVersionMarker(undefined)
  })

  it("clears a node getter so phonemizer does not see a Node environment", () => {
    const versions = {} as { node?: unknown }
    Object.defineProperty(versions, "node", {
      get: () => "18.20.0",
      configurable: true,
      enumerable: true,
    })
    stripNodeVersionMarker(versions)
    expect(typeof versions.node).not.toBe("string")
  })
})

describe("ensureReadableStreamAsyncIterator", () => {
  afterEach(() => {
    // Restore whatever the environment shipped so later tests keep native iter.
    ensureReadableStreamAsyncIterator()
  })

  it("lets for-await drain gzip when ReadableStream asyncIterator is missing", async () => {
    if (typeof DecompressionStream === "undefined") return
    const proto = ReadableStream.prototype as unknown as Record<symbol | string, unknown>
    const key = Symbol.asyncIterator
    const originalDesc = Object.getOwnPropertyDescriptor(ReadableStream.prototype, key)
    if (originalDesc && originalDesc.configurable === false) {
      ensureReadableStreamAsyncIterator()
      expect(typeof proto[key]).toBe("function")
      return
    }
    Object.defineProperty(ReadableStream.prototype, key, {
      value: undefined,
      configurable: true,
      writable: true,
    })
    try {
      expect(typeof proto[key]).not.toBe("function")
      ensureReadableStreamAsyncIterator()
      const { gzipSync } = await import("node:zlib")
      const raw = new TextEncoder().encode("espeak-ng-data")
      const gz = new Uint8Array(gzipSync(raw))
      const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))
      const chunks: Uint8Array[] = []
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
      }
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
      }
      expect(new TextDecoder().decode(out)).toBe("espeak-ng-data")
    } finally {
      if (originalDesc) Object.defineProperty(ReadableStream.prototype, key, originalDesc)
      else delete proto[key]
    }
  })
})

describe("patchPhonemizerBrowserUnpack", () => {
  it("forces the minified Node detection to false", () => {
    const src =
      'var g="object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node'
    expect(patchPhonemizerBrowserUnpack(src)).toBe(
      'var g="object"==typeof process&&"object"==typeof process.versions&&false',
    )
  })

  it("rewrites the shipped phonemizer bundle", () => {
    const src = shippedPhonemizerSource()
    expect(src).toContain('"string"==typeof process.versions.node')
    const patched = patchPhonemizerBrowserUnpack(src)
    expect(patched).not.toContain('"string"==typeof process.versions.node')
    expect(patched).toContain("&&false")
  })
})

describe("ensureArrayToSorted", () => {
  it("is a no-op when toSorted already exists", () => {
    expect(typeof Array.prototype.toSorted).toBe("function")
    ensureArrayToSorted()
    expect([3, 1, 2].toSorted()).toEqual([1, 2, 3])
  })
})

describe("ensureBrowserPhonemizerEnv", () => {
  it("does not throw", () => {
    expect(() => ensureBrowserPhonemizerEnv()).not.toThrow()
  })
})

describe("friendlyKokoroError", () => {
  it("explains the empty identifier list instead of echoing the phonemizer dump", () => {
    expect(
      friendlyKokoroError('Invalid language identifier: "en-us". Should be one of: .'),
    ).toMatch(/voice data failed to load/i)
  })

  it("points multilingual failures at the a*/b* English voices", () => {
    expect(
      friendlyKokoroError('Invalid language identifier: "fr-fr". Should be one of: en, en-us, en-gb.'),
    ).toMatch(/American a\* voices/i)
  })

  it("explains Safari's ReadableStream for-await crash", () => {
    expect(
      friendlyKokoroError("TypeError: undefined is not a function (near '...A of e...')"),
    ).toMatch(/couldn't unpack Kokoro's voice data/i)
  })

  it("leaves unrelated errors intact", () => {
    expect(friendlyKokoroError("WebGPU adapter lost")).toBe("WebGPU adapter lost")
  })
})
