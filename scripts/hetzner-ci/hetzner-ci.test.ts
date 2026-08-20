import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "../..")

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8")
}

describe("Hetzner CI bootstrap", () => {
  it("defaults to Docker Engine and keeps Colima opt-in", () => {
    const bootstrap = read("scripts/hetzner-ci/bootstrap.sh")
    expect(bootstrap).toMatch(/^#!/)
    expect(bootstrap).toContain("set -euo pipefail")
    expect(bootstrap).toContain("RUNTIME=docker")
    expect(bootstrap).toContain("--runtime=colima")
    expect(bootstrap).toContain("nested virtualization")
  })

  it("starts the canonical aquilla-dev-pg container e2e-up execs into", () => {
    const ensure = read("scripts/hetzner-ci/ensure-e2e-runtime.sh")
    expect(ensure).toContain("set -euo pipefail")
    expect(ensure).toContain("PG_CONTAINER=aquilla-dev-pg")
    expect(ensure).toContain("postgres:16")
    expect(ensure).toContain("POSTGRES_USER=aquilla")
    expect(ensure).toContain("5432:5432")
  })

  it("registers at most one e2e runner by default so shards share the box", () => {
    const install = read("scripts/hetzner-ci/install-runners.sh")
    expect(install).toContain("set -euo pipefail")
    expect(install).toContain("COUNT=1")
    expect(install).toContain("LABELS=hetzner,e2e")
    expect(install).toContain("genesis-ai-dev/aquilla")
  })
})

describe("E2E (Hetzner) workflow", () => {
  it("stays workflow_dispatch-only until a runner is Idle", () => {
    const workflow = read(".github/workflows/e2e-hetzner.yml")
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).not.toMatch(/^\s+pull_request:/m)
    expect(workflow).not.toMatch(/^\s+push:/m)
    expect(workflow).toContain("runs-on: [self-hosted, hetzner, e2e]")
    expect(workflow).toContain("pnpm test:e2e:smoke")
    expect(workflow).toContain("scripts/hetzner-ci/ensure-e2e-runtime.sh")
    expect(workflow).toContain("concurrency:")
    expect(workflow).toContain("e2e-hetzner")
    expect(workflow).toContain("cancel-in-progress: true")
  })
})
