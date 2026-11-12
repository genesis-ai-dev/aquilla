import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { childArgs, isNeonTargetCommand, NEON_TARGET_COMMANDS, scriptFor } from "./neon-target-args"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Every `neon:*` package script's command word, as neon-target.ts would see it. */
function packageScriptCommands(): { script: string; command: string }[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>
  }
  const found: { script: string; command: string }[] = []
  for (const [script, body] of Object.entries(pkg.scripts)) {
    const m = body.match(/scripts\/neon-target\.ts\s+(\S+)\s+(\S+)/)
    if (m) found.push({ script, command: m[2] })
  }
  return found
}

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
    expect(childArgs("backfill-file-kinds", ["--only", "47", "--apply"]))
      .toEqual(["scripts/neon-backfill-file-kinds.ts", "--only", "47", "--apply"])
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
    // AQU-2115: the nightly refresh passes the copy its budget and concurrency.
    // Dropping them would let one run spend the whole job's wall clock.
    expect(childArgs("copy-dev-audio-all", ["--budget-minutes", "240", "--concurrency", "4"]))
      .toEqual(["scripts/neon-copy-dev-audio-all.ts", "--budget-minutes", "240", "--concurrency", "4"])
    expect(childArgs("copy-dev-audio-all", ["--dry-run"]))
      .toEqual(["scripts/neon-copy-dev-audio-all.ts", "--dry-run"])
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

// AQU-1946: `repair-lane-grants` sat in the command union, in `scriptFor` and
// in the flag-passthrough list, and was still rejected by the hand-written
// `parseCommand` chain in neon-target.ts — so both
// `pnpm neon:repair-lane-grants:dev` and `:prod` printed the usage and exited 1
// without ever reaching the repair. These pin the wiring, not one command word.
describe("every neon-target command is actually reachable", () => {
  it("accepts every command in the one list", () => {
    for (const command of NEON_TARGET_COMMANDS) {
      expect(isNeonTargetCommand(command), `${command} must be accepted`).toBe(true)
    }
    expect(isNeonTargetCommand("repair-lane-grants")).toBe(true)
  })

  it("rejects a typo, an empty word, and a missing command", () => {
    expect(isNeonTargetCommand("repair-lane-grant")).toBe(false)
    expect(isNeonTargetCommand("")).toBe(false)
    expect(isNeonTargetCommand(undefined)).toBe(false)
  })

  it("accepts the command word of every neon:* package script", () => {
    const commands = packageScriptCommands()
    // Guard the guard: if the regex stops matching, this test must not pass empty.
    expect(commands.length).toBeGreaterThan(20)
    expect(commands.map((c) => c.command)).toContain("repair-lane-grants")
    for (const { script, command } of commands) {
      expect(isNeonTargetCommand(command), `pnpm ${script} passes '${command}'`).toBe(true)
    }
  })

  it("routes every non-migration command to its own script, never the migrate fallthrough", () => {
    for (const command of NEON_TARGET_COMMANDS) {
      const script = scriptFor(command)
      if (script === "scripts/neon-migrate.ts") {
        // Only the fixed-shape migration commands may land on neon-migrate.
        expect(["status", "apply", "baseline", "prepare-comments-key"]).toContain(command)
        continue
      }
      expect(fs.existsSync(path.join(REPO_ROOT, script)), `${script} for '${command}'`).toBe(true)
    }
  })
})
