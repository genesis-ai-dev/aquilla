import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Bridges the QA runner's Python suite into `pnpm test` (AQU-2365).
 *
 * The suite itself lives in `tests/` and uses stdlib `unittest`, so it needs no
 * pip install and an operator can run it directly:
 *
 *     cd agents/qa-biblica && python3 -m unittest discover -s tests -t .
 *
 * This file exists so the repo's own gate runs it too. It asserts on the
 * suite's exit status and surfaces its output on failure, rather than parsing
 * it — unittest's own reporting is better than anything re-derived here.
 */

const here = dirname(fileURLToPath(import.meta.url))

function python(args: string[]) {
  return spawnSync("python3", args, { cwd: here, encoding: "utf8" })
}

const probe = python(["--version"])
// Not a silent skip: when python3 is absent the reason is printed, so a green
// run never hides the fact that this suite did not execute. CI runners have it.
const hasPython = probe.status === 0
if (!hasPython) {
  console.warn(
    "[qa-biblica] python3 not found — the QA runner's unit tests did NOT run here. " +
      "They are the coverage for agents/qa-biblica; install python3 to run them locally.",
  )
}

describe.skipIf(!hasPython)("agents/qa-biblica Python suite", () => {
  it("passes `python3 -m unittest discover`", () => {
    const result = python(["-m", "unittest", "discover", "-s", "tests", "-t", ".", "-v"])
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    expect(output, output).toContain("Ran ")
    expect(result.status, output).toBe(0)
  })

  it("imports every module, so a syntax error in an unreached branch still fails", () => {
    const result = python([
      "-c",
      [
        "import importlib",
        "mods = ['api','baseline','bootstrap','cli','corpus','findings','qa_run','reader','report','scope','stage']",
        "mods += ['checks.' + m for m in ['capitalization_numbers','chapter_verse','characters_punctuation','key_terms_names','spelling_wordlist','text_integrity']]",
        "[importlib.import_module('qa_biblica.' + m) for m in mods]",
        "print('imported', len(mods), 'modules')",
      ].join("; "),
    ])
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    expect(result.status, output).toBe(0)
    expect(output).toContain("modules")
  })
})
