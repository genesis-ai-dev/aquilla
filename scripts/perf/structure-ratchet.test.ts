import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * AQU-2654 — a ratchet on the two components whose size is the cost.
 *
 * Every piece of state held by the workspace or the table re-renders the whole
 * of it when it changes (docs/decisions/0013-interaction-cost-is-commits-times-tree.md).
 * The interaction benchmark catches the result, but it needs a browser and a
 * stack, so it runs nightly. This runs with the unit tests and catches the
 * cause at the moment it is added: a new `useState` in a file whose state
 * should only shrink. (It does not cap lines: a line cap fails every bug fix
 * in a 21k-line file, and teaches people to ignore the check.)
 *
 * When you REMOVE state, lower the ceiling in the same change — that is the
 * ratchet. Raising a ceiling is a decision for a person, made in a PR
 * that says why the state cannot live in a smaller component or a store.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

interface Ceiling {
  file: string
  /** `useState(` / `useState<` call sites. */
  useState: number
}

const CEILINGS: Ceiling[] = [
  { file: "src/components/ProjectWorkspace.tsx", useState: 126 },
  // 49 since AQU-2655 (raised by Ryder): `capturedSelection` and
  // `pendingIdmlPointerSelection` were refs read in render, which stopped the
  // React Compiler compiling the file. They are state of the row that renders them.
  { file: "src/components/EditorTable.tsx", useState: 49 },
]

describe("structure ratchet (AQU-2654)", () => {
  it.each(CEILINGS)("$file does not gain state", ({ file, useState }) => {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8")
    const stateCalls = source.match(/\buseState\s*[<(]/g)?.length ?? 0
    expect(
      stateCalls,
      `${file} has ${stateCalls} useState calls (ceiling ${useState}). Put new state in the component that renders it, or in a store read through a selector.`,
    ).toBeLessThanOrEqual(useState)
  })
})
