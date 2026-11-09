// Is this checkout's git-hook wiring actually armed? (AQU-2161, AQU-1623)
//
// husky arms hooks from the `prepare` script at install time: it generates
// `.husky/_/` (git-ignored) and points `core.hooksPath` at it. Two routes leave
// a checkout without that wiring, and both are SILENT:
//
//   - `pnpm i --ignore-scripts` — the escape hatch people reach for when a
//     package's postinstall cannot reach its download host (AQU-2161). It skips
//     `prepare` along with everything else.
//   - a bare `git worktree add` plus a borrowed node_modules, which never ran an
//     install in the worktree at all (AQU-1623).
//
// Either way `pre-commit`, `prepare-commit-msg` and `pre-push` do nothing: no
// scope guard, no AQU-### injection, and a push that "finishes with nothing
// tested". An install that could not run `prepare` must be distinguishable from
// one that did, so this module is the shared predicate behind both
// `pnpm check:hooks` and `pnpm worktree:new`'s own check.
//
// Pure decision + an injected probe, so the branches are unit-testable without
// touching a real repository. Fails closed: an unresolvable `core.hooksPath` is
// "not armed", never a pass.

import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as path from "node:path"

/** The hook husky wires that we probe for. Every husky hook shares the dir. */
export const PROBED_HOOK = "pre-push"

export interface HooksProbe {
  /** `git config --get core.hooksPath` for the checkout; "" when unset. */
  hooksPath: string
  /** Does `<dir>/.husky/_/<PROBED_HOOK>` exist — i.e. did husky generate it? */
  huskyHookPresent: boolean
  /** Does the hook git would actually run exist (`<hooksPath>/<PROBED_HOOK>`)? */
  resolvedHookPresent: boolean
  /** Absolute path the probe resolved, for the message; "" when unset. */
  resolvedHookPath: string
}

export type HooksVerdict =
  | { armed: true; hooksPath: string }
  | { armed: false; lines: string[] }

/** Read the real checkout. Kept separate from the decision for testability. */
export function probeHooks(dir: string): HooksProbe {
  const result = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: dir,
    encoding: "utf8",
  })
  const hooksPath = result.status === 0 ? result.stdout.trim() : ""
  const resolvedHookPath = hooksPath
    ? path.join(path.resolve(dir, hooksPath), PROBED_HOOK)
    : ""
  return {
    hooksPath,
    huskyHookPresent: existsSync(path.join(dir, ".husky", "_", PROBED_HOOK)),
    resolvedHookPresent: resolvedHookPath ? existsSync(resolvedHookPath) : false,
    resolvedHookPath,
  }
}

/**
 * Armed means all three hold: husky generated its hook dir, `core.hooksPath` is
 * set, and the hook git resolves through that path is really there. Anything
 * else reports what is missing and how to fix it — loudly, because the whole
 * point is that this state is otherwise invisible.
 */
export function assessHooks(probe: HooksProbe, dir: string): HooksVerdict {
  if (probe.huskyHookPresent && probe.hooksPath && probe.resolvedHookPresent) {
    return { armed: true, hooksPath: probe.hooksPath }
  }

  const lines = [
    `git hooks are NOT armed in ${dir}.`,
    `  .husky/_/${PROBED_HOOK}: ${probe.huskyHookPresent ? "present" : "MISSING"}`,
    `  core.hooksPath: ${probe.hooksPath || "UNSET"}`,
  ]
  if (probe.hooksPath) {
    lines.push(
      `  resolved ${PROBED_HOOK}: ${probe.resolvedHookPath} (${probe.resolvedHookPresent ? "present" : "MISSING"})`,
    )
  }
  lines.push(
    "core.hooksPath is the relative .husky/_, which husky generates and git ignores.",
    "Without it, pre-commit, prepare-commit-msg and pre-push do not run, and a push",
    "finishes with nothing tested and no AQU-### injected into the commit message.",
    "Fix: run `pnpm run prepare` in this checkout (an install with --ignore-scripts,",
    "or a bare `git worktree add`, skips husky). Then re-run `pnpm check:hooks`.",
  )
  return { armed: false, lines }
}
