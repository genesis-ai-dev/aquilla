// Stale-checkout guard for the Codex → Aquilla migration fetch (AQU-971).
//
// migrate-fetch reuses an existing checkout without pulling, while migrate-all
// records the GitLab API's HEAD sha as "migrated" — so a run against a
// months-old directory maps ancient notebooks, writes retractions/reanchors
// derived from them into the live datastore, and then marks CURRENT content as
// done. That is exactly how the 2026-08-20 poison sweep damaged 30+ prod
// projects. This module closes the hole: a reused checkout must MATCH the
// remote head before it is read, or the fetch fails loudly.
//
// Deliberately never mutates beyond a fast-forward pull:
//   - `git pull --ff-only` refuses divergence and refuses to overwrite
//     conflicting local modifications (git's own checkout safety), so a Codex
//     Editor live workspace with unpushed translator work is never clobbered.
//   - On any failure the guard THROWS with remediation instead of resetting
//     or deleting — the directory may not belong to the migration at all.
// Fails closed: an unresolvable remote head is an error, not a pass.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as fs from "node:fs"
import git from "isomorphic-git"
import http from "isomorphic-git/http/node"

const execFileP = promisify(execFile)

/** Strip embedded credentials from anything we echo (URLs ride in argv). */
export function redactToken(text: string): string {
  return text.replace(/oauth2:[^@\s]+@/g, "oauth2:***@")
}

/** IO seams so the decision flow is unit-testable without a network. */
export interface CheckoutGuardIo {
  /** Current HEAD commit of the local checkout; null when unresolvable. */
  resolveLocalHead(): Promise<string | null>
  /** Tip of the remote default branch; null when unresolvable. */
  resolveRemoteHead(): Promise<string | null>
  /** Fast-forward the checkout to the remote tip; throws when not possible
   *  (divergence, conflicting local modifications, auth, network). */
  fastForward(): Promise<void>
}

export interface CheckoutGuardOptions {
  dir: string
  io: CheckoutGuardIo
  log?: (line: string) => void
}

/**
 * Verify (and, when trivially safe, fast-forward) a reused checkout so the
 * migration never reads stale notebooks. Resolves when the checkout matches
 * the remote head; throws a descriptive error otherwise.
 */
export async function ensureCheckoutCurrent(opts: CheckoutGuardOptions): Promise<void> {
  const { dir, io } = opts
  const log = opts.log ?? (() => {})

  const remote = await io.resolveRemoteHead()
  if (!remote) {
    throw new Error(
      `cannot resolve the remote head for ${dir} — refusing to migrate content that cannot be `
      + `verified as current (AQU-971). Check network/credentials and retry.`,
    )
  }
  const local = await io.resolveLocalHead()
  if (!local) {
    throw new Error(
      `cannot resolve HEAD in the existing checkout at ${dir} (corrupt or partial clone). `
      + `Delete the directory to force a fresh clone (AQU-971).`,
    )
  }
  if (local === remote) {
    log(`Checkout is current (${local.slice(0, 8)}).`)
    return
  }

  log(`Checkout at ${local.slice(0, 8)} != remote ${remote.slice(0, 8)}; attempting fast-forward…`)
  let ffError: string | null = null
  try {
    await io.fastForward()
  } catch (e) {
    ffError = redactToken(e instanceof Error ? e.message : String(e))
  }
  const after = ffError ? local : await io.resolveLocalHead()
  if (!ffError && after === remote) {
    log(`Fast-forwarded ${local.slice(0, 8)} → ${remote.slice(0, 8)}.`)
    return
  }

  throw new Error(
    `stale checkout at ${dir}: local HEAD ${local.slice(0, 8)} does not match remote head `
    + `${remote.slice(0, 8)} and a fast-forward was not possible`
    + `${ffError ? ` (${ffError.split("\n")[0]})` : after !== remote ? ` (still at ${String(after).slice(0, 8)} after pull)` : ""}. `
    + `Migrating from stale notebooks retracts and re-anchors live content (AQU-971), so this run `
    + `refuses to proceed. Fix by syncing the project in Codex Editor, running `
    + `\`git -C ${dir} pull --ff-only\`, or deleting the directory to force a fresh clone.`,
  )
}

export interface GitCheckoutGuardConfig {
  dir: string
  /** Plain repo URL (no embedded credentials). */
  url: string
  gitlabToken: string
  defaultBranch: string
}

/** Real IO: isomorphic-git for ref reads, system git for the ff pull (it
 *  enforces checkout safety and handles the shallow clones migrate-fetch
 *  makes; the authed URL rides in argv only, never persisted to config). */
export function gitCheckoutGuardIo(cfg: GitCheckoutGuardConfig): CheckoutGuardIo {
  const authedUrl = cfg.url.replace(/^https:\/\//, `https://oauth2:${cfg.gitlabToken}@`)
  return {
    async resolveLocalHead() {
      try {
        return await git.resolveRef({ fs, dir: cfg.dir, ref: "HEAD" })
      } catch {
        return null
      }
    },
    async resolveRemoteHead() {
      try {
        const refs = await git.listServerRefs({
          http,
          url: cfg.url,
          prefix: `refs/heads/${cfg.defaultBranch}`,
          onAuth: () => ({ username: "oauth2", password: cfg.gitlabToken }),
        })
        return refs.find((r) => r.ref === `refs/heads/${cfg.defaultBranch}`)?.oid ?? null
      } catch {
        return null
      }
    },
    async fastForward() {
      try {
        await execFileP("git", ["-C", cfg.dir, "pull", "--ff-only", authedUrl, cfg.defaultBranch], {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        })
      } catch (e) {
        const err = e as { stderr?: string; message?: string }
        const stderr = err.stderr?.trim() ?? ""
        // Surface git's actual reason ("fatal: Not possible to fast-forward…"),
        // not its progress chatter ("From https://…").
        const reason =
          stderr.split("\n").find((l) => l.startsWith("fatal:") || l.startsWith("error:"))
          ?? stderr
          ?? err.message
          ?? String(e)
        throw new Error(redactToken(reason), { cause: e })
      }
    },
  }
}
