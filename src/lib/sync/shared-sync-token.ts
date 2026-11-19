// One sync-token mint per (identity, project, file) for the whole tab (AQU-2654).
//
// Every `makeSyncTokenMinter` closure used to keep its own token, and the
// audio fetcher its own again, so opening one file POSTed /sync-token once per
// holder that needed the file: the workspace's file fetcher, its outbox
// minter, the route-scoped fetcher, each read hook's own fetcher, the audio
// reads. They are all the same credential. A mint is shared by key while it is
// in flight and reused until it nears expiry; each holder keeps its own fast
// path and its own callbacks.
//
// The session JWT is part of the key, so an account switch cannot pick up the
// previous account's token (AQU-616). A failed mint is not kept: everyone who
// joined it sees the failure, and the next call tries again.
//
// A module of its own, and the mint is passed in rather than imported, so a
// caller (and a test that replaces "@/lib/sync/sync-token") decides what a
// mint is.

import { onElevationGranted } from "@/lib/errors/elevation-required-signal"
import { registerSharedStateResetForTests } from "@/lib/request-coalescer"
import type { SyncTokenResponse } from "./sync-token"

/** Tokens are replaced this long before they expire. */
export const SYNC_TOKEN_REFRESH_SAFETY_MS = 30_000

export type SharedMint =
  | { ok: true; resp: SyncTokenResponse; mintedAt: number }
  | { ok: false; err: unknown }

const sharedMints = new Map<string, Promise<SharedMint>>()

/** `apiUrl` undefined is the default identity host. */
export function sharedMintKey(apiUrl: string | undefined, jwt: string, projectId: string, fileId: string): string {
  return `${apiUrl ?? ""}\n${jwt}\n${projectId}\n${fileId}`
}

export function hasSharedMint(key: string): boolean {
  return sharedMints.has(key)
}

/** Start a mint and make it the shared one for `key`, whatever was there. */
export function startSharedMint(key: string, mint: () => Promise<SyncTokenResponse>): Promise<SharedMint> {
  // Counted from before the request, so a slow mint never looks younger than
  // it is.
  const mintedAt = Date.now()
  const slot: Promise<SharedMint> = mint().then(
    (resp): SharedMint => ({ ok: true, resp, mintedAt }),
    (err: unknown): SharedMint => {
      if (sharedMints.get(key) === slot) sharedMints.delete(key)
      return { ok: false, err }
    },
  )
  sharedMints.set(key, slot)
  return slot
}

function isUsable(mint: SharedMint): boolean {
  return mint.ok && mint.mintedAt + mint.resp.expiresIn * 1000 > Date.now() + SYNC_TOKEN_REFRESH_SAFETY_MS
}

/**
 * The shared mint for `key`: joins one in flight, reuses an unexpired one,
 * otherwise mints. A failure is shared by everyone who joined it; a token near
 * expiry is replaced by whoever notices first.
 */
export async function joinSharedMint(key: string, mint: () => Promise<SyncTokenResponse>): Promise<SharedMint> {
  for (;;) {
    const existing = sharedMints.get(key)
    if (!existing) return startSharedMint(key, mint)
    const settled = await existing
    if (!settled.ok || isUsable(settled)) return settled
    if (sharedMints.get(key) === existing) sharedMints.delete(key)
  }
}

/**
 * For a caller that keeps its own cache (the audio fetcher): the shared token
 * for the default identity host and when it was minted. Rejects with the
 * mint's error.
 */
export async function fetchSharedSyncToken(
  jwt: string,
  projectId: string,
  fileId: string,
  mint: (jwt: string, projectId: string, fileId: string) => Promise<SyncTokenResponse>,
): Promise<{ resp: SyncTokenResponse; mintedAt: number }> {
  const outcome = await joinSharedMint(sharedMintKey(undefined, jwt, projectId, fileId), () =>
    mint(jwt, projectId, fileId),
  )
  if (!outcome.ok) throw outcome.err
  return { resp: outcome.resp, mintedAt: outcome.mintedAt }
}

// AQU-2003: an un-elevated platform admin is minted a Viewer token for a
// foreign project. Once they step up, the next mint must carry the elevated
// role, so nothing minted before the grant is handed out again (the audio
// fetcher's own cache does the same).
onElevationGranted(() => sharedMints.clear())

registerSharedStateResetForTests(() => sharedMints.clear())
