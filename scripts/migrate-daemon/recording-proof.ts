import { createHash } from 'node:crypto'
import { parseCodexNotebook } from '../../src/lib/codex-editor/parse-codex'
import type { CodexCell } from '../../src/lib/codex-editor/types'
import { collectAllCellAudio, type AudioImport } from '../../src/lib/migrate/audio'
import { normalizeAttachmentPath } from '../../src/lib/migrate/audio-copy'

const metadataKeys = ['sizeBytes', 'sampleRate', 'channels', 'durationSec', 'bitrateKbps']

export function recordingMetadata(cell: CodexCell, take: AudioImport): Record<string, unknown> {
  const att = (cell.metadata.attachments as unknown as Record<string, Record<string, unknown>> | undefined)?.[take.legacyAudioId] ?? {}
  const nested = (att.metadata ?? {}) as Record<string, unknown>
  return Object.fromEntries(metadataKeys.map(key => [key, att[key] ?? nested[key] ?? null]))
}

export function recordingBinding(file: string, cellId: string, take: AudioImport, metadata?: Record<string, unknown>): string {
  return JSON.stringify([file, cellId, take.legacyAudioId, normalizeAttachmentPath(take.diskRelPath), take.slot,
    take.createdBy ?? null, take.createdAt ?? null, take.mimeType ?? null, take.durationMs ?? null,
    ...metadataKeys.map(key => metadata?.[key] ?? null)])
}

export interface RecordingProof {
  projectId: number
  sha: string
  file: string
  cellId: string
  take: AudioImport
  audioMetadata?: Record<string, unknown>
}

/** Bind audited evidence to the same live recording in BOTH revisions. A text
 * edit elsewhere in its notebook is irrelevant; a changed, deleted, duplicated
 * or moved recording is not. No filenames, display names or timestamps alone
 * authorize recovery. The caller still verifies the identified bytes. */
export async function revalidateRecordingProofs<T extends RecordingProof>(
  entries: T[], projectId: number, sha: string,
  read: (sha: string, file: string) => Promise<Uint8Array | null>,
  record: (proof: Record<string, unknown>) => void = () => {},
): Promise<T[]> {
  if (!Number.isSafeInteger(projectId) || projectId < 1 || !/^[a-f0-9]{40}$/.test(sha)) throw Error('Invalid source identity')
  const results: T[] = []
  const cache = new Map<string, Promise<Map<string, number> | null>>()
  const index = (ref: string, file: string) => {
    const key = `${ref}:${file}`
    let pending = cache.get(key)
    if (!pending) {
      pending = (async () => {
        const bytes = await read(ref, file)
        if (bytes === null) return null
        const counts = new Map<string, number>()
        for (const cell of parseCodexNotebook(Buffer.from(bytes).toString('utf8')).cells) {
          for (const take of collectAllCellAudio(cell)) {
            const binding = recordingBinding(file, cell.metadata.id, take, recordingMetadata(cell, take))
            counts.set(binding, (counts.get(binding) ?? 0) + 1)
          }
        }
        return counts
      })()
      cache.set(key, pending)
    }
    return pending
  }
  for (const entry of entries) {
    if (entry.projectId !== projectId) continue
    if (!/^[a-f0-9]{40}$/.test(entry.sha) || !/^[^/\\]+\.codex$/.test(entry.file)
      || !entry.cellId || !entry.take?.legacyAudioId || !entry.take.diskRelPath) throw Error('Invalid recording evidence')
    const key = recordingBinding(entry.file, entry.cellId, entry.take, entry.audioMetadata)
    const old = await index(entry.sha, entry.file)
    const current = await index(sha, entry.file)
    const accepted = old?.get(key) === 1 && current?.get(key) === 1
    record({ code: accepted ? 'historical-recording-revalidated' : 'historical-recording-changed', projectId,
      sha, previousSha: entry.sha, file: entry.file, cellId: entry.cellId,
      bindingSha256: createHash('sha256').update(key).digest('hex') })
    if (accepted) results.push({ ...entry, sha })
  }
  return results
}
