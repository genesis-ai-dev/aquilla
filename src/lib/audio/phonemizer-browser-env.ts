// kokoro-js phonemizes through xenova/phonemizer. Two browser traps:
//
// 1. Phonemizer inspects `process.versions.node` at module load. When that
//    marker is a string it decodes espeak data with `Buffer.from`. Vite's
//    optimized kokoro-js dep injects the marker into the worker without
//    Buffer, the unpack IIFE rejects, and American English (`a*` → "en-us")
//    fails with: Invalid language identifier: "en-us". Should be one of: .
//    Force `g` off via patchPhonemizerBrowserUnpack (Vite plugin) and exclude
//    kokoro-js from optimizeDeps so the worker bundles the patched source.
//
// 2. The browser unpack is:
//      blob.stream().pipeThrough(new DecompressionStream("gzip"))
//      for await (const chunk of stream) …
//    Safari/WebKit workers often lack ReadableStream async iteration, so
//    that IIFE rejects as:
//      TypeError: undefined is not a function (near '...A of e...')
//
// Apply the stream polyfill *before* importing kokoro-js (see
// phonemizer-browser-env-init.ts). This module itself has no side effects
// so unit tests can import the helpers without mutating the test process.

export function stripNodeVersionMarker(versions: { node?: unknown } | undefined): void {
  if (!versions) return
  if (typeof versions.node !== "string") return
  try {
    delete versions.node
  } catch {
    // Non-configurable getter — fall through to defineProperty.
  }
  if (typeof versions.node !== "string") return
  try {
    Object.defineProperty(versions, "node", {
      value: undefined,
      configurable: true,
      writable: true,
      enumerable: true,
    })
  } catch {
    try {
      versions.node = undefined
    } catch {
      // Last resort: phonemizer will still see a Node environment.
    }
  }
}

type AsyncIterableReadableStream = ReadableStream<Uint8Array> & {
  [Symbol.asyncIterator]?: () => AsyncGenerator<Uint8Array>
  values?: () => AsyncGenerator<Uint8Array>
}

async function* readableStreamValues(this: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = this.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value !== undefined) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Force phonemizer's Emscripten `g` (Node?) flag off. When `g` is true it
 * decodes the embedded espeak archive with `Buffer.from` — missing in a
 * worker without Node shims — and the gzip unpack IIFE rejects, leaving
 * `list_voices()` empty (`Should be one of: .`).
 */
export function patchPhonemizerBrowserUnpack(code: string): string {
  return code
    .replaceAll('"string"==typeof process.versions.node', "false")
    .replaceAll('"string" === typeof process.versions.node', "false")
    .replaceAll("typeof process.versions.node === \"string\"", "false")
    .replaceAll("typeof process.versions.node==='string'", "false")
}

/** Phonemizer's gzip unpack uses `for await (const chunk of stream)`. Always
 *  install a getReader() iterator — a Node stream polyfill may put a broken
 *  asyncIterator on the prototype that does not work on Blob/DecompressionStream. */
export function ensureReadableStreamAsyncIterator(): void {
  if (typeof ReadableStream === "undefined") return
  const proto = ReadableStream.prototype as AsyncIterableReadableStream
  try {
    proto[Symbol.asyncIterator] = readableStreamValues
  } catch {
    if (typeof proto[Symbol.asyncIterator] !== "function") {
      Object.defineProperty(proto, Symbol.asyncIterator, {
        value: readableStreamValues,
        configurable: true,
        writable: true,
      })
    }
  }
  if (typeof proto.values !== "function") proto.values = readableStreamValues
}

/** Phonemizer's invalid-language throw uses Array.prototype.toSorted. */
export function ensureArrayToSorted(): void {
  const proto = Array.prototype as unknown as {
    toSorted?: (compareFn?: (a: unknown, b: unknown) => number) => unknown[]
  }
  if (typeof proto.toSorted === "function") return
  proto.toSorted = function toSorted(
    this: unknown[],
    compareFn?: (a: unknown, b: unknown) => number,
  ): unknown[] {
    return this.slice().sort(compareFn)
  }
}

export function ensureBrowserPhonemizerEnv(): void {
  ensureReadableStreamAsyncIterator()
  ensureArrayToSorted()
  if (typeof process === "undefined") return
  stripNodeVersionMarker(process.versions)
}

export function friendlyKokoroError(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim()
  if (/undefined is not a function/i.test(collapsed) || /is not (async )?iterable/i.test(collapsed)) {
    return "This browser couldn't unpack Kokoro's voice data. Reload the page, or try a current Chrome / Safari."
  }
  if (/reading ['"]from['"]/i.test(collapsed)) {
    return "Kokoro's English voice data failed to load. Reload the page and try generating again."
  }
  if (/Invalid language identifier/i.test(collapsed) && /Should be one of:\s*\.?\s*$/i.test(collapsed)) {
    return "Kokoro's English voice data failed to load. Reload the page and try generating again."
  }
  if (/Invalid language identifier/i.test(collapsed)) {
    return "Kokoro's on-device engine speaks English (American a* voices, British b* voices). Switch this line to OmniVoice, Gemini, or MMS for other languages."
  }
  return raw
}
