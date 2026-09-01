import type { Plugin } from "vite"
import { patchPhonemizerBrowserUnpack } from "../src/lib/audio/phonemizer-browser-env.ts"

/** Rewrites phonemizer's Node detection before the gzip unpack IIFE runs. */
export function phonemizerBrowserUnpackPlugin(): Plugin {
  return {
    name: "phonemizer-browser-unpack",
    enforce: "pre",
    transform(code, id) {
      const normalized = id.replace(/\\/g, "/")
      if (!normalized.includes("/phonemizer/dist/phonemizer")) return
      const patched = patchPhonemizerBrowserUnpack(code)
      if (patched === code) return
      return { code: patched, map: null }
    },
  }
}
