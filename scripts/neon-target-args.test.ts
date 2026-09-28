import { describe, expect, it } from "vitest"
import { childArgs } from "./neon-target-args"

describe("neon-target hands the backfill its flags", () => {
  it("passes everything after the command through to a backfill script", () => {
    // The whole bug: this used to come back as just the script, so the
    // scoped backfill could not be asked for and the unscoped one ran instead.
    expect(childArgs("backfill-progress", ["--missing-books"]))
      .toEqual(["scripts/neon-backfill-progress.ts", "--missing-books"])
    expect(childArgs("backfill-activity", ["--missing-only", "--dry-run"]))
      .toEqual(["scripts/neon-backfill-activity.ts", "--missing-only", "--dry-run"])
    // AQU-1240: the lane backfill takes --apply / --project / --limit the same way.
    expect(childArgs("backfill-lanes", ["--apply", "--project", "p1", "--limit", "5"]))
      .toEqual(["scripts/neon-backfill-lanes.ts", "--apply", "--project", "p1", "--limit", "5"])
    expect(childArgs("verify-lanes", ["--require-complete"]))
      .toEqual(["scripts/neon-verify-lanes.ts", "--require-complete"])
  })

  it("still runs an unscoped backfill when nothing follows the command", () => {
    expect(childArgs("backfill-progress", [])).toEqual(["scripts/neon-backfill-progress.ts"])
  })

  it("keeps the migration commands' fixed shape and forwards nothing to them", () => {
    expect(childArgs("apply", ["--whatever"])).toEqual(["scripts/neon-migrate.ts", "apply"])
    expect(childArgs("status", [])).toEqual(["scripts/neon-migrate.ts", "status"])
    expect(childArgs("baseline", [])).toEqual(["scripts/neon-migrate.ts", "baseline"])
    expect(childArgs("prepare-comments-key", ["--dry-run"])).toEqual(["scripts/neon-migrate.ts", "prepare-comments-key"])
  })
})
