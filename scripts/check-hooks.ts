// `pnpm check:hooks` — fail loudly when this checkout's git hooks are dead.
//
// AQU-2161: an install that could not run husky's `prepare` (the
// `--ignore-scripts` escape hatch, or a bare `git worktree add`) is otherwise
// indistinguishable from one that did, and every hook silently does nothing.
// Run this after any such install, and before trusting a push.
//
// Exits 0 when armed, 1 when not. The decision lives in lib/hooks-armed.ts.

import { assessHooks, probeHooks } from "./lib/hooks-armed"

function main(): void {
  const dir = process.cwd()
  const verdict = assessHooks(probeHooks(dir), dir)
  if (verdict.armed) {
    console.log(`[check:hooks] ✅ hooks armed (core.hooksPath=${verdict.hooksPath})`)
    return
  }
  console.error(`[check:hooks] ${verdict.lines[0]}`)
  for (const line of verdict.lines.slice(1)) console.error(line)
  process.exit(1)
}

main()
