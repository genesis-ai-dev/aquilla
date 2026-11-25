/**
 * AQU-1616 — render the lane batch backfill plan as the markdown the
 * conductor reviews.
 *
 * Split out of `lane-batch-backfill.ts` (which is still well over the ~500
 * line target) because the renderer shares no state with the planner: it
 * reads a finished `LaneBatchReport` and returns a string. The planner's
 * module re-exports `renderLaneBatchReport` from its own path, so every
 * caller — `scripts/neon-backfill-lane-batch.ts` and the planner's own
 * test — is unaffected.
 *
 * The report shapes stay declared in `lane-batch-backfill.ts`; they are read
 * here as types only, so nothing is imported back at runtime.
 */

import type { LaneBatchCounts, LaneBatchReport, ScopeTagMatch } from "./lane-batch-backfill"

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function countLines(counts: LaneBatchCounts): string[] {
  const lines: string[] = []
  const write = (title: string, rows: Record<string, number | Record<string, number>>) => {
    lines.push(`### ${title}`, "")
    for (const [key, value] of Object.entries(rows)) {
      if (value && typeof value === "object") {
        for (const [rule, count] of Object.entries(value)) lines.push(`- ${key}.${rule}: ${count}`)
      } else {
        lines.push(`- ${key}: ${value}`)
      }
    }
    lines.push("")
  }
  write("Lanes", counts.lanes)
  write("Member scopes", counts.scopes)
  write("Invites", counts.invites)
  write("Links", counts.links)
  write("Back-translations", counts.backtranslations)
  write("Audio", counts.audio)
  write("Audio validators", counts.audioValidators)
  write("Concepts", counts.concepts)
  write("Progress", counts.progress)
  return lines
}

/** Markdown the conductor reviews. Project names are included here on purpose. */
export function renderLaneBatchReport(report: LaneBatchReport): string {
  const lines = [
    "# Lane batch backfill",
    "",
    report.mode === "apply"
      ? "Apply. Writes run only after migrations 0138 and 0152 are on the target."
      : "Dry run. Nothing is written. An accidental write fails because the session is read-only.",
    "",
    "Events are not rewritten. Lane rows are not deleted. `lanes.legacy_tag` is not changed. `legacy_tag ''` stays the bridge.",
    "",
    "Progress apply recomputes each file with the existing progress projection, so source totals land on the source lane and no `''` row is manufactured.",
    "",
    "## Counts",
    "",
    ...countLines(report.counts),
    "## Guessed lane languages",
    "",
  ]
  if (report.guessedLanguages.length === 0) lines.push("None.", "")
  else {
    lines.push("| Project | Lane | Legacy tag | Name | Language | Reason |", "| --- | --- | --- | --- | --- | --- |")
    for (const row of report.guessedLanguages) {
      lines.push(
        `| ${cell(row.projectName)} | ${cell(row.laneId)} | ${cell(row.legacyTag)} | ${cell(row.name)} | ${cell(row.language)} | ${cell(row.reason)} |`,
      )
    }
    lines.push("")
  }
  lines.push("## Unresolvable rows", "")
  if (report.unresolvable.length === 0) lines.push("None.", "")
  else {
    lines.push("| Rule | Project | Key | Reason |", "| --- | --- | --- | --- |")
    for (const row of report.unresolvable) {
      lines.push(`| ${cell(row.rule)} | ${cell(row.projectName)} | ${cell(row.key)} | ${cell(row.reason)} |`)
    }
    lines.push("")
  }
  lines.push("## AQU-1585 name/code disagreements", "")
  if (report.aqu1585.disagreements.length === 0) lines.push("None. These are reported and not auto-fixed.", "")
  else {
    lines.push("Reported only. The backfill does not rename the lane or delete the duplicate.", "")
    lines.push("| Project | Lane | Name | lang_code | Derived code |", "| --- | --- | --- | --- | --- |")
    for (const row of report.aqu1585.disagreements) {
      lines.push(
        `| ${cell(row.projectName)} | ${cell(row.laneId)} | ${cell(row.name)} | ${cell(row.langCode)} | ${cell(row.derivedCode)} |`,
      )
    }
    lines.push("")
  }
  lines.push("## AQU-1585 duplicate names", "")
  if (report.aqu1585.duplicateNames.length === 0) lines.push("None.", "")
  else {
    lines.push("| Project | Name | Lanes |", "| --- | --- | --- |")
    for (const row of report.aqu1585.duplicateNames) {
      lines.push(`| ${cell(row.projectName)} | ${cell(row.name)} | ${cell(row.laneIds.join(", "))} |`)
    }
    lines.push("")
  }
  const scopeSection = (title: string, rows: ScopeTagMatch[]) => {
    lines.push(`## ${title}`, "")
    if (rows.length === 0) {
      lines.push("None.", "")
      return
    }
    lines.push("| Surface | Project | User | Value | Matches |", "| --- | --- | --- | --- | --- |")
    for (const row of rows) {
      lines.push(
        `| ${row.surface} | ${cell(row.projectName)} | ${cell(row.userId ?? "")} | ${cell(row.value)} | ${row.matches} |`,
      )
    }
    lines.push("")
  }
  scopeSection("Scope tags matching zero lanes", report.scopeTags.zero)
  scopeSection("Scope tags matching two lanes", report.scopeTags.two)
  return lines.join("\n")
}
