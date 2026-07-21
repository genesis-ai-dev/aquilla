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
    expect(read("../Dockerfile")).toMatch(
      /^FROM docker\.io\/cloudflare\/sandbox:0\.7\.0-python$/m,
    )
  })
})
