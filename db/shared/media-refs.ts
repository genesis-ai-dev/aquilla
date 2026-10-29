// AQU-2114 — the one copy of "which R2 media objects a project still
// references", shared by the two jobs that must never disagree about it:
//
//   • the nightly R2 cleanup (AQU-1856, sync-worker/src/r2-gc.ts) deletes
//     everything NOT in this set;
//   • the dev audio copy (scripts/dev-audio-copy.ts) copies exactly what IS in
//     this set from the prod bucket into the dev bucket.
//
// A second, drifted copy of these queries would mean dev copies objects its own
// nightly cleanup then deletes, every night. So the queries live here, keyed on
// the bare `AquillaDb` handle (db/shim/postgres.ts) that both a Worker and a
// `tsx` maintenance script can supply, and `r2-gc.ts` re-exports them for its
// existing callers.
//
// The commentary on WHY each reference is kept came with the queries from the
// cleanup, and is as load-bearing here: a reference missed here is media the
// cleanup deletes and the copy never restores.

import type { AquillaDb } from "../shim/postgres"

export type GcNamespace = "audio" | "voice" | "artifact"

/** Suffix of the Inworld clone-id cache that rode alongside a reference clip.
 *  Nothing writes it since AQU-2291 removed Inworld cloning; legacy sidecars
 *  still map onto their clip so they are collected with it. */
export const CLONE_CACHE_SUFFIX = ".inworld.json"
/** AQU-2095: suffix of the stored-waveform sidecar that rides alongside a clip.
 *  Mirrors PEAKS_SIDECAR_SUFFIX in src/lib/audio/peaks-sidecar.ts. */
export const PEAKS_SIDECAR_SUFFIX = ".peaks"

/**
 * Split a bucket key (prefix already stripped) into the namespace it belongs to
 * and the identity to look up. Returns null for anything not swept — which is
 * everything except the three media namespaces.
 */
export function classifyKey(rest: string): { namespace: GcNamespace; projectId: string; ref: string } | null {
  const parts = rest.split("/")
  if (parts[0] === "projects") {
    // projects/{pid}/files/{fid}/audio/{audioId}
    if (parts.length === 6 && parts[2] === "files" && parts[4] === "audio") {
      const [, projectId, , fileId, , audioId] = parts
      if (!projectId || !fileId || !audioId) return null
      // AQU-2095: a `.peaks` sidecar is the clip's waveform, not a clip of its
      // own — no cell_audio row will ever name it. Map it back onto the clip it
      // describes, as the voice namespace does for the clone cache, so it is
      // kept while the clip is live and collected with it.
      const ref = audioId.endsWith(PEAKS_SIDECAR_SUFFIX)
        ? audioId.slice(0, -PEAKS_SIDECAR_SUFFIX.length)
        : audioId
      if (!ref) return null
      return { namespace: "audio", projectId, ref: `${fileId}/${ref}` }
    }
    // projects/{pid}/voices/{refId} and the legacy {refId}.inworld.json clone
    // cache, which lives or dies with the clip it was derived from. Custom-voice
    // consent records (voices/custom/{voiceId}/consent.json) are deeper and
    // never classified, so never swept.
    if (parts.length === 4 && parts[2] === "voices") {
      const [, projectId, , name] = parts
      if (!projectId || !name) return null
      const ref = name.endsWith(CLONE_CACHE_SUFFIX)
        ? name.slice(0, -CLONE_CACHE_SUFFIX.length)
        : name
      if (!ref) return null
      return { namespace: "voice", projectId, ref }
    }
    return null
  }
  if (parts[0] === "artifacts") {
    // artifacts/{pid}/{artifactId} and artifacts/{pid}/{artifactId}/original.ext
    if (parts.length === 3 || parts.length === 4) {
      const [, projectId, artifactId] = parts
      if (!projectId || !artifactId) return null
      return { namespace: "artifact", projectId, ref: artifactId }
    }
    return null
  }
  return null
}

/**
 * The audio object a take's url plays: `frontier-audio://{name}` names an
 * object in the take's own file; an `/audio/{project}/{file}/{name}` path names
 * its file too. Anything else (an outside media URL, a legacy LFS link) is not
 * in this bucket and keeps nothing alive.
 */
export function playedObject(url: string | null): { fileId: string | null; name: string } | null {
  if (!url) return null
  const scheme = "frontier-audio://"
  if (url.startsWith(scheme)) {
    const name = url.slice(scheme.length)
    return name && !name.includes("/") ? { fileId: null, name } : null
  }
  const path = url.match(/^\/audio\/[^/]+\/([^/]+)\/([^/]+)$/)
  if (path) return { fileId: decodeURIComponent(path[1]!), name: decodeURIComponent(path[2]!) }
  return null
}

/** Every `(fileId, audioId)` an audio object is still reachable through. */
export async function loadAudioRefs(db: AquillaDb, projectId: string): Promise<Set<string>> {
  const refs = new Set<string>()
  // Live takes. `deleted = 1` is the soft-delete the projection writes, so its
  // bytes ARE collectable — that is the point of sweeping regenerated takes.
  //
  // A live take keeps three names alive, not one: its own id, the object its
  // url plays, and the take it was cut from. They differ for a cut piece
  // (AQU-1767): `cell.audio.cut` gives each later piece a new id but the SAME
  // url, so every piece plays the original take's bytes. Keyed on the id alone,
  // deleting a cut take's first piece (the original row) left those bytes with
  // no live id, and the next sweep deleted the audio the surviving pieces play.
  const takes = await db
    .prepare(`SELECT file_id, audio_id, url, piece_of FROM cell_audio WHERE project_id = ? AND deleted = 0`)
    .bind(projectId)
    .all<{ file_id: string; audio_id: string; url: string | null; piece_of: string | null }>()
  for (const r of takes.results ?? []) {
    refs.add(`${r.file_id}/${r.audio_id}`)
    if (r.piece_of) refs.add(`${r.file_id}/${r.piece_of}`)
    const played = playedObject(r.url)
    if (played) refs.add(played.fileId ? `${played.fileId}/${played.name}` : `${r.file_id}/${played.name}`)
  }

  // Agent-API audio artifacts: the bytes sit in the per-file audio layout keyed
  // by the artifact id standing in for a file id (schema.sql, 0064).
  const artifactAudio = await db
    .prepare(
      `SELECT id::text AS id, audio_id FROM artifacts
        WHERE project_id = ? AND kind = 'audio' AND audio_id IS NOT NULL`,
    )
    .bind(projectId)
    .all<{ id: string; audio_id: string }>()
  for (const r of artifactAudio.results ?? []) {
    refs.add(`${r.id}/${r.audio_id}`)
    // `uuid::text` is canonical lowercase; the key was written from whatever the
    // uploader generated. They agree today, but a case mismatch would read as
    // "orphaned" and delete referenced media, so admit both spellings — a false
    // KEEP costs storage, a false DELETE costs someone's audio.
    refs.add(`${r.id.toLowerCase()}/${r.audio_id}`)
  }

  // A queued/running diarization job still has to fetch its input.
  const jobs = await db
    .prepare(
      `SELECT file_id, audio_object FROM diarization_jobs
        WHERE project_id = ? AND status IN ('queued', 'running')`,
    )
    .bind(projectId)
    .all<{ file_id: string; audio_object: string }>()
  for (const r of jobs.results ?? []) refs.add(`${r.file_id}/${r.audio_object}`)

  return refs
}

/**
 * Every voices/ clip id a voice or a take still points at, as far as Postgres
 * can tell. Custom-voice training recordings are named only by their consent
 * record in R2, not by any row — the sweep adds those itself
 * (`customVoiceTrainingRefs`, read by sync-worker/src/r2-gc.ts).
 */
export async function loadVoiceRefs(db: AquillaDb, projectId: string): Promise<Set<string>> {
  const refs = new Set<string>()
  // The voice library lives in the project settings blob, so a clip assigned
  // to a voice is in use even before it has voiced a single line:
  //   • designPreviewAudioId — the Inworld voice-design preview the voice
  //     plays back when opened (docs/INWORLD-TTS.md);
  //   • referenceAudioId — the short-clip clone voices AQU-2291 removed. Still
  //     read so a settings blob that has not been rewritten yet keeps its clip:
  //     a false KEEP costs storage, a false DELETE costs someone's audio.
  const voices = await db
    .prepare(
      `SELECT DISTINCT r.ref
         FROM project_settings ps,
              jsonb_array_elements(
                CASE WHEN jsonb_typeof(ps.settings::jsonb -> 'ttsSettings' -> 'voices') = 'array'
                     THEN ps.settings::jsonb -> 'ttsSettings' -> 'voices'
                     ELSE '[]'::jsonb END
              ) AS v,
              LATERAL (VALUES (v->>'designPreviewAudioId'), (v->>'referenceAudioId')) AS r(ref)
        WHERE ps.project_id = ? AND r.ref IS NOT NULL`,
    )
    .bind(projectId)
    .all<{ ref: string }>()
  for (const r of voices.results ?? []) if (r.ref) refs.add(r.ref)

  // And any take that records the voices/ clip it was made from, so "revert
  // to source" keeps working.
  const takes = await db
    .prepare(
      `SELECT DISTINCT reference_audio_id AS ref FROM cell_audio
        WHERE project_id = ? AND deleted = 0 AND reference_audio_id IS NOT NULL`,
    )
    .bind(projectId)
    .all<{ ref: string }>()
  for (const r of takes.results ?? []) if (r.ref) refs.add(r.ref)

  return refs
}

/** Custom-voice consent records: `voices/custom/{voiceId}/consent.json` under a
 *  project prefix. Mirrors `customVoiceConsentKey` in sync-worker/src/custom-voice.ts. */
export const CUSTOM_VOICE_CONSENT_RE = /\/voices\/custom\/[^/]+\/consent\.json$/

/**
 * The training recordings a custom voice's consent record names. They live in
 * the same voices/ store as every other clip and no Postgres row points at
 * them, so without this the sweep would delete a real person's recordings — the
 * evidence the audit record describes — a day after training started.
 *
 * Throws on a record it cannot read: the caller must then treat the project's
 * whole voices/ namespace as "cannot tell", never as "nothing referenced".
 */
export function customVoiceTrainingRefs(consentJson: string): string[] {
  const parsed: unknown = JSON.parse(consentJson)
  const ids = (parsed as { referenceAudioIds?: unknown } | null)?.referenceAudioIds
  if (!Array.isArray(ids)) throw new Error("consent record has no referenceAudioIds")
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0)
}
