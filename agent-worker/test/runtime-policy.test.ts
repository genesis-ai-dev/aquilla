import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ENABLE_INTERNET, IMAGE_NAME, INACTIVITY_TIMEOUT_MS, INSTANCE_TYPE } from "../src/container-exec"

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url).href), "utf8")

// The Sandbox Durable Object (src/sandbox-do.ts) cannot be imported here: it
// pulls `cloudflare:workers`. Its policy lives in container-exec.ts, which can,
// and the source is read to check that start() actually consumes it.
describe("sandbox runtime policy", () => {
  it("keeps arbitrary internet egress disabled for untrusted code", () => {
    expect(ENABLE_INTERNET).toBe(false)
    const source = read("../src/sandbox-do.ts")
    expect(source).toMatch(/enableInternet:\s*ENABLE_INTERNET/)
    expect(source).not.toMatch(/enableInternet:\s*true/)
  })

  it("keeps the 10-minute idle sleep (AQU-1848 pool semantics) on both start and restart", () => {
    expect(INACTIVITY_TIMEOUT_MS).toBe(10 * 60 * 1000)
    const source = read("../src/sandbox-do.ts")
    // Once after start(), once in the constructor for a restarted Durable Object.
    expect(source.match(/setInactivityTimeout\(INACTIVITY_TIMEOUT_MS\)/g)).toHaveLength(2)
  })

  it("sizes the container as the retired instance_type did", () => {
    expect(INSTANCE_TYPE).toBe("standard-1")
    expect(read("../src/sandbox-do.ts")).toMatch(/instance:\s*INSTANCE_TYPE/)
  })

  it("exports the Durable Object classes wrangler binds from the entry module", () => {
    const entry = read("../src/index.ts")
    expect(entry).toMatch(/export \{ Sandbox \} from "\.\/sandbox-do"/)
    expect(entry).toMatch(/export \{ SandboxPool \} from "\.\/pool-do"/)
    expect(entry).not.toMatch(/@cloudflare\/sandbox/)
  })

  it("pairs the sandbox-shim donor image with the installed SDK version", () => {
    const pkg = JSON.parse(read("../package.json")) as {
      dependencies: Record<string, string>
    }
    const version = pkg.dependencies["@cloudflare/sandbox"]
    expect(version, "package.json must pin @cloudflare/sandbox").toMatch(/^\d+\.\d+\.\d+$/)
    const dockerfile = read("../Dockerfile")
    // 1.x publishes `cloudflare/sandbox:<version>` as a FROM-scratch donor that
    // only carries sandbox-shim; the package and the shim speak a versioned
    // protocol, so the tag must be the package version. It is a named stage
    // (not a bare `COPY --from=docker.io/...`) so the pairing is one FROM line
    // that tooling can read. Bump both together (docs/DEPENDENCY-RULES.md).
    const donor = dockerfile.match(/^FROM docker\.io\/cloudflare\/sandbox:(\S+) AS sandbox-shim$/m)
    expect(donor?.[1], "Dockerfile donor stage tag").toBe(version)
    expect(dockerfile).toMatch(
      /^COPY --from=sandbox-shim \/usr\/local\/bin\/sandbox-shim \/usr\/local\/bin\/sandbox-shim$/m,
    )
    // The donor is not runnable, so it can never be the runtime base.
    const froms = dockerfile.match(/^FROM .*$/gm) ?? []
    expect(froms.filter((line) => line.includes("cloudflare/sandbox"))).toHaveLength(1)
    expect(froms.length).toBeGreaterThanOrEqual(2)
  })

  it("ships the runners the Durable Object execs", () => {
    const dockerfile = read("../Dockerfile")
    expect(dockerfile).toMatch(/^COPY runner\/run\.py runner\/run\.mjs \/opt\/aquilla\/$/m)
    expect(read("../runner/run.py")).toContain("sys.stdin.read()")
    expect(read("../runner/run.mjs")).toContain("runInThisContext")
  })

  it("declares the image under the name the Durable Object starts, in every profile", () => {
    const toml = read("../wrangler.toml")
    const profiles = toml.match(/^\[\[(?:env\.\w+\.)?containers\]\]$/gm) ?? []
    expect(profiles).toHaveLength(3)
    expect(toml.match(/^scheduling_policy = "durable_object"$/gm)).toHaveLength(3)
    expect(
      toml.match(new RegExp(`^\\[(?:env\\.\\w+\\.)?containers\\.images\\.${IMAGE_NAME}\\]$`, "gm")),
    ).toHaveLength(3)
    // Keys the durable_object policy rejects at deploy time.
    expect(toml).not.toMatch(/^(image|instance_type|max_instances) = /m)
    // Container application names must be unique on the account.
    const names = toml.match(/^name = "aquilla-agent-sandbox[^"]*-sandbox"$/gm) ?? []
    expect(new Set(names).size).toBe(3)
  })
})
