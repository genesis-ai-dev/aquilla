import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve, sep } from "node:path"
import { describe, expect, it } from "vitest"
import viteConfig from "../vite.config"
import {
  TRANSFORMERS_ORT_SPECIFIER,
  resolveTransformersOrtExternWasm,
  transformersOrtPackageDir,
} from "./transformers-ort-extern-wasm"

const ROOT = resolve(import.meta.dirname, "..")

/** What Vite turns into an emitted asset: `new URL("<file>.wasm", import.meta.url)`. */
const EMBEDDED_WASM_URL = /new URL\("[^"]+\.wasm",\s*import\.meta\.url\)/

const fromApp = createRequire(join(ROOT, "package.json"))
const transformersDir = dirname(dirname(fromApp.resolve("@huggingface/transformers")))

describe("transformers' ONNX Runtime is built without its embedded WASM", () => {
  it("resolves the extern-WASM build inside the onnxruntime-web transformers depends on", () => {
    const target = resolveTransformersOrtExternWasm(ROOT)
    const ortDir = transformersOrtPackageDir(ROOT)

    expect(existsSync(target)).toBe(true)
    expect(target.startsWith(ortDir + sep)).toBe(true)

    // Not the copy the app pins for mms-worker: transformers nests its own.
    const transformersPkg = JSON.parse(readFileSync(join(transformersDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
    }
    const ortPkg = JSON.parse(readFileSync(join(ortDir, "package.json"), "utf8")) as { version: string }
    expect(ortPkg.version).toBe(transformersPkg.dependencies["onnxruntime-web"])
  })

  it("picks a module that embeds no WASM URL, unlike the default build of the same entry", () => {
    const externBuild = readFileSync(resolveTransformersOrtExternWasm(ROOT), "utf8")
    expect(externBuild).not.toMatch(EMBEDDED_WASM_URL)

    // The control: the build Vite would resolve without the alias does embed
    // one, so the assertion above is checking the right thing.
    const defaultBuild = readFileSync(
      join(transformersOrtPackageDir(ROOT), "dist", "ort.webgpu.bundle.min.mjs"),
      "utf8",
    )
    expect(defaultBuild).toMatch(EMBEDDED_WASM_URL)
  })

  it("aliases exactly the onnxruntime-web entry transformers' web build imports", () => {
    // If a transformers bump starts importing a different entry, the alias
    // stops matching and the oversized WASM silently returns to dist.
    const webBuild = readFileSync(join(transformersDir, "dist", "transformers.web.js"), "utf8")
    const imported = new Set(
      [...webBuild.matchAll(/from\s*"(onnxruntime-web[^"]*)"/g)].map((match) => match[1]),
    )
    expect([...imported]).toEqual([TRANSFORMERS_ORT_SPECIFIER])

    const config = typeof viteConfig === "function"
      ? viteConfig({ mode: "test", command: "build" })
      : viteConfig
    const aliases = (config as { resolve: { alias: { find: string | RegExp; replacement: string }[] } }).resolve.alias
    const matching = aliases.filter(
      ({ find }) => find instanceof RegExp && find.test(TRANSFORMERS_ORT_SPECIFIER),
    )
    expect(matching.map(({ replacement }) => replacement)).toEqual([resolveTransformersOrtExternWasm(ROOT)])

    // mms-worker's own import must keep the WASM bundled with it.
    expect(aliases.some(({ find }) => find instanceof RegExp && find.test("onnxruntime-web/wasm"))).toBe(false)
  })
})
