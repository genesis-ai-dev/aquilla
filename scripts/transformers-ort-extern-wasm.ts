// Keeps transformers.js's ONNX Runtime WASM out of the build output.
//
// `@huggingface/transformers`' web build does `import "onnxruntime-web/webgpu"`.
// Under the default export condition that is `ort.webgpu.bundle.min.mjs`, which
// contains `new URL("ort-wasm-simd-threaded.asyncify.wasm", import.meta.url)`;
// Vite turns that into an emitted asset. The asset is never fetched: outside a
// ServiceWorker, transformers points `env.backends.onnx.wasm.wasmPaths` at
// jsDelivr before any session exists, and ONNX Runtime only falls back to its
// embedded copy when no path override is set (verified against a production
// build in a real browser — with the CDN blocked the app errors rather than
// reading the local file). It is also not small: 22.5 MiB under transformers
// 4.2.0 and 25.6 MiB under 4.3.0, the latter over the 25 MiB Cloudflare Workers
// per-asset limit, which failed every preview and deploy build (#927, #1006).
//
// onnxruntime-web ships the same module without the embedded URL behind its
// `onnxruntime-web-use-extern-wasm` export condition. That condition cannot be
// switched on globally: `src/lib/audio/mms-worker.ts` imports the app's own
// `onnxruntime-web/wasm` and DOES load the WASM bundled with it. So
// vite.config.ts aliases only the one specifier transformers imports.

import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

/** The only onnxruntime-web entry transformers' web build imports. */
export const TRANSFORMERS_ORT_SPECIFIER = "onnxruntime-web/webgpu"

/** onnxruntime-web's export condition for "the WASM is hosted elsewhere". */
export const ORT_EXTERN_WASM_CONDITION = "onnxruntime-web-use-extern-wasm"

type OrtPackageJson = {
  name?: string
  exports?: Record<string, unknown>
}

/**
 * Directory of the onnxruntime-web copy transformers depends on — a nightly
 * that differs from the release the app pins, so it must be resolved from
 * transformers, not from the repo root.
 */
export function transformersOrtPackageDir(root: string): string {
  const fromApp = createRequire(join(root, "package.json"))
  const fromTransformers = createRequire(fromApp.resolve("@huggingface/transformers"))
  // The package does not export its package.json, so resolve an entry it does
  // export and walk up to the manifest.
  let directory = dirname(fromTransformers.resolve(TRANSFORMERS_ORT_SPECIFIER))
  for (;;) {
    const manifest = join(directory, "package.json")
    if (existsSync(manifest) && readManifest(manifest).name === "onnxruntime-web") return directory
    const parent = dirname(directory)
    if (parent === directory) {
      throw new Error("[transformers-ort] could not find the onnxruntime-web package transformers depends on")
    }
    directory = parent
  }
}

function readManifest(path: string): OrtPackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as OrtPackageJson
}

/**
 * Absolute path of the extern-WASM build of `onnxruntime-web/webgpu` inside
 * transformers' dependency tree. Read from the package's own export map rather
 * than guessed, and loud when it is gone: silently falling back to the default
 * build would put the oversized WASM straight back into `dist`.
 */
export function resolveTransformersOrtExternWasm(root: string): string {
  const directory = transformersOrtPackageDir(root)
  const subpath = `./${TRANSFORMERS_ORT_SPECIFIER.slice("onnxruntime-web/".length)}`
  const entry = readManifest(join(directory, "package.json")).exports?.[subpath] as
    | { import?: Record<string, unknown> }
    | undefined
  const target = entry?.import?.[ORT_EXTERN_WASM_CONDITION]
  if (typeof target !== "string") {
    throw new Error(
      `[transformers-ort] ${directory} no longer exports "${subpath}" under the "${ORT_EXTERN_WASM_CONDITION}" condition; ` +
        "see scripts/transformers-ort-extern-wasm.ts",
    )
  }
  return join(directory, target)
}
