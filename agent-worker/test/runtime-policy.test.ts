import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url).href), "utf8")

describe("sandbox runtime policy", () => {
  it("keeps arbitrary internet egress disabled for untrusted code", () => {
    expect(read("../src/index.ts")).toMatch(/enableInternet\s*=\s*false/)
  })

  it("uses the SDK image variant that actually provides Python and pip", () => {
    const pkg = JSON.parse(read("../package.json")) as {
      dependencies: Record<string, string>
    }
    const version = pkg.dependencies["@cloudflare/sandbox"]
    expect(version, "package.json must pin @cloudflare/sandbox").toMatch(
      /^\d+\.\d+\.\d+$/,
    )
    // Dockerfile FROM must stay on the -python tag of the same SDK version —
    // the generic image is not guaranteed to ship pip (see Dockerfile).
    expect(read("../Dockerfile")).toMatch(
      new RegExp(
        `^FROM docker\\.io/cloudflare/sandbox:${version.replaceAll(".", "\\.")}-python$`,
        "m",
      ),
    )
  })
})
