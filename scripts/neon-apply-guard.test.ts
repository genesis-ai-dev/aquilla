import { describe, expect, it } from "vitest"
import { decideApplyGuard, directApplyRefusal, snapshotArgs, snapshotBranchName } from "./neon-apply-guard"

const BASE = {
  projectId: "sweet-paper-88472094",
  parentBranch: "production",
  cliVersion: "2.30.0",
  now: new Date("2026-10-11T14:32:05.123Z"),
} as const

describe("production apply is gated on a snapshot (AQU-1877)", () => {
  it("refuses a bare production apply and prints the exact command to take one", () => {
    const decision = decideApplyGuard({ ...BASE, target: "production", command: "apply", flags: [] })
    expect(decision.kind).toBe("refuse")
    if (decision.kind !== "refuse") return
    expect(decision.message).toContain(
      "npx --yes neon@2.30.0 branches create --project-id sweet-paper-88472094 " +
        "--name premigrate-2026-10-11-14-32-05 --parent production",
    )
    expect(decision.message).toContain("--snapshot")
    expect(decision.message).toContain("--no-snapshot")
  })

  it("takes the snapshot itself with --snapshot", () => {
    const decision = decideApplyGuard({ ...BASE, target: "production", command: "apply", flags: ["--snapshot"] })
    expect(decision).toMatchObject({
      kind: "snapshot",
      branchName: "premigrate-2026-10-11-14-32-05",
      args: snapshotArgs("sweet-paper-88472094", "production", "premigrate-2026-10-11-14-32-05"),
    })
  })

  it("proceeds with a warning under --no-snapshot", () => {
    const decision = decideApplyGuard({ ...BASE, target: "production", command: "apply", flags: ["--no-snapshot"] })
    expect(decision.kind).toBe("proceed")
    if (decision.kind !== "proceed") return
    expect(decision.note).toContain("no snapshot was taken")
  })

  it("refuses both flags at once", () => {
    expect(
      decideApplyGuard({ ...BASE, target: "production", command: "apply", flags: ["--snapshot", "--no-snapshot"] }),
    ).toMatchObject({ kind: "refuse" })
  })

  it("leaves dev, local and read-only commands alone", () => {
    expect(decideApplyGuard({ ...BASE, target: "dev", command: "apply", flags: [] })).toEqual({ kind: "proceed" })
    expect(decideApplyGuard({ ...BASE, target: "local", command: "apply", flags: [] })).toEqual({ kind: "proceed" })
    expect(decideApplyGuard({ ...BASE, target: "production", command: "status", flags: [] })).toEqual({ kind: "proceed" })
    expect(decideApplyGuard({ ...BASE, target: "production", command: "baseline", flags: [] })).toEqual({ kind: "proceed" })
  })

  it("refuses a flag that cannot do anything, instead of dropping it", () => {
    // neon-target used to hand migration commands a fixed argv, so a typo'd
    // flag vanished silently (the AQU-1278 class of bug).
    expect(decideApplyGuard({ ...BASE, target: "production", command: "apply", flags: ["--snapshots"] }))
      .toMatchObject({ kind: "refuse" })
    expect(decideApplyGuard({ ...BASE, target: "dev", command: "apply", flags: ["--snapshot"] }))
      .toMatchObject({ kind: "refuse" })
  })

  it("names the snapshot branch so it sorts by time", () => {
    expect(snapshotBranchName(new Date("2026-01-02T03:04:05Z"))).toBe("premigrate-2026-01-02-03-04-05")
  })
})

describe("the direct `pnpm neon:apply` entry point is gated too", () => {
  const argv = ["node", "neon-migrate.ts", "apply"]

  it("refuses a remote apply with no decision, and names the target-aware commands", () => {
    const refusal = directApplyRefusal(argv, { NEON_PG_HOST: "ep-prod.neon.tech" })
    expect(refusal).toContain("without a snapshot decision")
    expect(refusal).toContain("pnpm neon:apply:prod --snapshot")
  })

  it("lets a local apply through — there is no Neon branch to snapshot", () => {
    expect(directApplyRefusal(argv, { AQUILLA_LOCAL_PG_URL: "postgresql://localhost/aquilla_dev" })).toBeNull()
  })

  it("lets an explicit flag or a decision made by neon-target through", () => {
    expect(directApplyRefusal([...argv, "--no-snapshot"], { NEON_PG_HOST: "ep-prod.neon.tech" })).toBeNull()
    expect(directApplyRefusal(argv, { NEON_PG_HOST: "ep-prod.neon.tech", AQUILLA_MIGRATION_SNAPSHOT_DECISION: "production:apply" }))
      .toBeNull()
  })
})
