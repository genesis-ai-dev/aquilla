import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { harnessHealth, type Evidence, type Recorded } from "./health"

export const MARKER = "<!-- aquilla-adversarial -->"

interface SuiteTest { title: string; status: string; evidence: { "smart-testing-evidence"?: Evidence & { deployedBuild?: { sha: string } | null } } }

export interface CommentInput {
  sha: string
  runUrl: string
  /** Set when the suite never ran, e.g. the preview never served this commit. */
  notRun?: string
  tests?: SuiteTest[]
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ")

/**
 * The sticky PR comment. It never reads as a pass unless the canary passed,
 * attacks reached verdicts, and none failed. Advisory: it posts no check.
 */
export function renderComment(input: CommentInput): string {
  const head = [MARKER, "## Adversarial Jev", "", `Commit \`${input.sha.slice(0, 8)}\` · [run log](${input.runUrl})`, ""]
  const footer = ["", "The adversarial suite points Jev at this branch's preview under hostile conditions, red-team goals, and reworded goals. "
    + "Verdicts come from server state, never from the agent. Advisory only: this does not block the merge. "
    + "[How it works](https://github.com/genesis-ai-dev/aquilla/blob/dev/smart-tests/adversarial/README.md)."]
  if (input.notRun) return [...head, `**NOT RUN.** ${input.notRun}`, ...footer].join("\n")
  const tests = input.tests ?? []
  const recorded: Recorded[] = tests.map((test) => ({
    project: test.title.startsWith("canary:") ? "canary" : "attacks",
    status: test.status,
    evidence: test.evidence["smart-testing-evidence"] ?? null,
  }))
  const attacks = recorded.filter((entry) => entry.project === "attacks")
  const health = harnessHealth(recorded, attacks.length || 1)
  const verdict = (entry: Recorded) => entry.evidence?.outcome.verdict ?? "no evidence"
  const failures = attacks.filter((entry) => verdict(entry) === "product_failure")
  const served = tests.find((test) => test.evidence["smart-testing-evidence"]?.deployedBuild)
    ?.evidence["smart-testing-evidence"]?.deployedBuild?.sha
  const stale = served && !input.sha.startsWith(served)
  const headline = !health.available ? `**HARNESS UNAVAILABLE.** ${health.reason} This run says nothing about the change.`
    : stale ? `**NOT VERIFIED.** The preview served \`${served}\`, not this commit.`
      : failures.length ? `**${failures.length} FAILURE${failures.length > 1 ? "S" : ""} FOUND.** Check the agent's actions in the run log before treating one as a bug.`
        : "**No failures found.** Inconclusive attacks below were not tested."
  const counts = new Map<string, number>()
  for (const entry of attacks) counts.set(verdict(entry), (counts.get(verdict(entry)) ?? 0) + 1)
  const order = ["product_failure", "inconclusive", "passed", "no evidence"]
  const rows = [...attacks].sort((a, b) => order.indexOf(verdict(a)) - order.indexOf(verdict(b)))
    .map((entry) => {
      const evidence = entry.evidence
      // The agent's own stop reason tells a provider flake apart from a real miss.
      const agentError = evidence?.agents?.flatMap((agent) => agent?.errors ?? [])
        .map((error) => error.reason).find(Boolean)
      const note = verdict(entry) === "passed" ? "" : cell([evidence?.outcome.reason ?? "",
        ...(evidence?.outcome.diffs ?? []), agentError ? `Agent: ${agentError}` : ""].filter(Boolean).join(" "))
      return `| \`${evidence?.attackId ?? "?"}\` | ${evidence?.mode ?? ""} | ${verdict(entry)} | ${note} |`
    })
  return [
    ...head, headline, "",
    [...counts].map(([name, count]) => `${name}: ${count}`).join(" · "), "",
    ...(health.available && rows.length ? ["| Attack | Mode | Verdict | Note |", "| --- | --- | --- | --- |", ...rows] : []),
    ...footer,
  ].join("\n")
}

// CLI: tsx comment.ts <sha> <runUrl> [<resultsDir> | --not-run <reason>]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sha, runUrl, third, reason] = process.argv.slice(2)
  const input: CommentInput = third === "--not-run" ? { sha, runUrl, notRun: reason }
    : { sha, runUrl, tests: (JSON.parse(readFileSync(path.join(third, "suite.json"), "utf8")) as { tests: SuiteTest[] }).tests }
  process.stdout.write(renderComment(input) + "\n")
}
