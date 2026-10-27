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
    // AQU-1196: --apply is the book-code backfill's write gate — dropping it
    // would turn the production write into a silent dry run.
    expect(childArgs("backfill-book-codes", ["--apply", "--verbose"]))
      .toEqual(["scripts/neon-backfill-book-codes.ts", "--apply", "--verbose"])
    // AQU-1240: the lane backfill takes --apply / --project / --limit the same way.
    expect(childArgs("backfill-lanes", ["--apply", "--project", "p1", "--limit", "5"]))
      .toEqual(["scripts/neon-backfill-lanes.ts", "--apply", "--project", "p1", "--limit", "5"])
    expect(childArgs("backfill-lane-batch", ["--apply", "--project", "p1", "--out", "reports"]))
      .toEqual(["scripts/neon-backfill-lane-batch.ts", "--apply", "--project", "p1", "--out", "reports"])
    expect(childArgs("verify-lanes", ["--require-complete"]))
      .toEqual(["scripts/neon-verify-lanes.ts", "--require-complete"])
    expect(childArgs("repair-lane-grants", ["--out", "report.json", "--project", "p1"]))
      .toEqual(["scripts/neon-repair-lane-grants.ts", "--out", "report.json", "--project", "p1"])
    // AQU-1941: --production is the prune's write gate — dropping it would turn
    // a refused production apply into a silent dry run.
    expect(childArgs("prune-phantom-voices", ["--apply", "--production", "--only", "p1"]))
      .toEqual(["scripts/neon-prune-phantom-voices.ts", "--apply", "--production", "--only", "p1"])
    expect(childArgs("fold-cast-by-character", ["--apply", "--production", "--only", "p1"]))
      .toEqual(["scripts/neon-fold-cast-by-character.ts", "--apply", "--production", "--only", "p1"])
    // AQU-1953: the seed extract reads --no-upload itself (one-off hand-off, no R2 put).
    expect(childArgs("seed-extract", ["--no-upload"]))
      .toEqual(["scripts/seed-extract.ts", "--no-upload"])
    // AQU-1775: --dry-run must reach the scrub, or a rehearsal deletes for real.
    expect(childArgs("scrub-integrations", ["--dry-run"]))
      .toEqual(["scripts/neon-scrub-integrations.ts", "--dry-run"])
    // AQU-2114: --project names the one project to copy and --dry-run keeps the
    // rehearsal read-only; dropping either copies the wrong thing, for real.
    expect(childArgs("copy-dev-audio", ["--project", "p1", "--dry-run"]))
      .toEqual(["scripts/neon-copy-dev-audio.ts", "--project", "p1", "--dry-run"])
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
