// AQU-2086: the audio-id convention, shared by the SPA recorder and the Agent
// API's LinkMedia compile step.
//
// A take's id embeds the id it was SEEDED with, verbatim between hyphens:
//
//   audio-{seed}-{timestamp}-{random}
//
// The SPA reads that seed back out (`audioIdSeededWith`) as the one O(1)
// provenance signal it has per attachment: the imported SOURCE clip of a media
// file is seeded with the FILE id, every dub take with the CELL id. The Target
// track, the source-clip resolver, the recorder's takes list and the export
// scope all turn on it, so a take minted any other way is not a dub to them.
// LinkMedia used to attach the artifact's bare UUID, which is why an audio
// clip linked through the Agent API never sounded on the Target track even
// once it was in the right lane. Minting through this module is what keeps
// externally attached audio and recorded audio one kind of thing.
//
// Pure: no DOM, no Workers bindings, so both packages can import it.

/** The characters R2 object names dislike (":" etc.) are normalised; the seed
 *  is capped so a long cell id cannot push the object name past R2's limit. */
export function normaliseAudioIdSeed(seed: string): string {
  return seed.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
}

/**
 * Build a stable audio id in the desktop format: `audio-{seed}-{timestamp}-{random}`.
 * Seed a dub take with its CELL id and an imported source clip with its FILE id —
 * `audioIdSeededWith` depends on exactly that.
 */
export function buildAudioId(seed: string): string {
  const ts = Date.now()
  const rnd = Math.random().toString(36).slice(2, 11)
  return `audio-${normaliseAudioIdSeed(seed)}-${ts}-${rnd}`
}

/**
 * SUB-29 (AQU-646): was this audioId seeded with `id` when built? `buildAudioId`
 * embeds its seed verbatim for uuid ids (the normaliser only touches chars R2
 * dislikes), so provenance is readable back out. Relies on the seed convention
 * above staying stable — change `buildAudioId`'s seeding and this breaks.
 */
export function audioIdSeededWith(audioId: string | undefined, id: string): boolean {
  if (!audioId || !id) return false
  return audioId.includes(`-${normaliseAudioIdSeed(id)}-`)
}
