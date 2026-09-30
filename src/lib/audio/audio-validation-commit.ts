// AQU-490: what has to happen after an audio validation vote, everywhere.
//
// THE BUG THIS EXISTS FOR (Sam, 2026-09-22). A vote cast in the Recording tab,
// the recorder, the voice panel or the selection island left the text view's
// gutter showing the old state until a reload. The gutter was not failing to
// listen — `useFileAudioAttachments` has subscribed to this file's channel
// since it was written, and eight other producers poke it after attaching,
// trimming, denoising and transcribing. Nobody was speaking. Not one
// validation path poked it.
//
// The gutter's OWN click was in the same state and merely hid it: it emitted
// and returned, and the control's optimistic vote painted the icon it expected
// to see. So the picture was right for the wrong reason, and stayed right
// until the row recycled.
//
// THE FLUSH IS LOAD-BEARING, and it is why this is a function rather than a
// line of `notifyAudioAttachmentsChanged` at five call sites. A vote rides the
// outbox. Poke the channel first and the refetch reads the server BEFORE the
// vote reaches it, so the gutter repaints the old value — a visible flicker
// backwards, which is worse than the staleness it replaced. The order here is
// the one CellTakeBlock's transcribe path already established: flush, then
// poke.
//
// The other refresh path cannot cover this. `useFileAudioAttachments` also
// refetches when the outbox moves, but only for files with a live optimistic
// SHADOW, and a vote creates none — shadows are for attachments appearing and
// disappearing, not for who signed one off. That gate is right as it stands.
import { useCallback, useMemo, useRef } from "react"
import { flushOutboxBatch, type TokenMintResult } from "@/lib/sync/outbox-flush"
import { buildProjectAwareMinter } from "@/lib/sync/cqrs-bridge"
import { notifyAudioAttachmentsChanged } from "./audio-attachments-bus"

export interface AudioValidationCommitDeps {
  /** The same per-file minter the workspace's own flushes use. */
  getTokenForFile: (projectId: string, fileId: string) => Promise<TokenMintResult>
}

/**
 * A vote landed on one or more takes. Get it to the server, then tell every
 * reader of those files to refetch.
 *
 * TAKES A SET OF FILES, not one. A bulk validation over a selection can span a
 * subtitle file and its cue sheet — the takes live on the heard lines while
 * the selection is of subtitle rows — and poking only the active file leaves
 * the other one stale. That was already true of the whole-file action before
 * this existed, and is the kind of thing a single-file signature invites.
 *
 * Never throws: a failed flush is a queued event that the periodic flusher
 * will carry, and a validation is not worth an error dialog over. The poke
 * still happens, because the server may well have the vote already.
 */
export async function commitAudioValidation(
  fileIds: Iterable<string>,
  deps: AudioValidationCommitDeps,
): Promise<void> {
  const files = new Set([...fileIds].filter(Boolean))
  if (files.size === 0) return
  try {
    await flushOutboxBatch({ getTokenForFile: deps.getTokenForFile })
  } catch {
    // Best effort. The vote stays queued and the poke below is still worth
    // making — another client's write may have moved the same take.
  }
  for (const fileId of files) notifyAudioAttachmentsChanged(fileId)
}

/**
 * The same thing for a surface that holds a session rather than a minter.
 *
 * TAKES THE JWT, rather than reaching for `useFrontierSession` itself. That
 * hook pulls the accounts query in behind it, and every component that mounts
 * this would then need a QueryClientProvider in its tests — a real cost paid
 * by surfaces that already have the session in their hands. The four callers
 * all do.
 *
 * The minter is built once and reads the jwt through a ref, so a token
 * refresh does not throw away its per-(project, file) cache — which a bulk
 * validation over forty lines would otherwise feel as forty mints.
 */
export function useAudioValidationCommit(jwt: string | null): (fileIds: Iterable<string>) => Promise<void> {
  const jwtRef = useRef<string | null>(jwt)
  jwtRef.current = jwt
  const getTokenForFile = useMemo(
    () => buildProjectAwareMinter(() => jwtRef.current),
    [],
  )
  return useCallback(
    (fileIds: Iterable<string>) => commitAudioValidation(fileIds, { getTokenForFile }),
    [getTokenForFile],
  )
}
