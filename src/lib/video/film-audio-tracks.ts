// Which language the film speaks. (AQU-646, 2026-08-18)
//
// The client's masters carry SIXTY-FIVE audio renditions — the show is dubbed
// into all of them — and not one is marked DEFAULT. Only English carries an
// AUTOSELECT hint. So a player left to itself is free to choose, and the list
// is alphabetical by name with Amharic at the top: that is how Sam ended up
// with a film speaking a language nobody asked for, the moment the streaming
// player replaced Safari's own.
//
// The lesson is that the choice cannot be left to the player. This decides it,
// as a pure function over whatever list the player hands us, so the rule is the
// same on both pipelines and testable against the real manifest.

/** What we need from a rendition, on either pipeline. The streaming player's
 *  `MediaPlaylist` and Safari's own `AudioTrack` both reduce to this. */
export interface FilmAudioTrack {
  /** The player's own handle for it — an index for the library, an id string
   *  for the element's native list. */
  id: number | string
  /** Human-readable and already good: "Arabic (Egypt)", "Cantonese (Hong
   *  Kong)". Straight from the manifest, so no language table of our own. */
  name: string
  /** "ar-EG", "en", "apd" — absent on some renditions. */
  lang: string | null
  /** HLS accessibility tags, when the manifest bothers to set them. */
  characteristics?: string | null
  default?: boolean
  autoselect?: boolean
}

/** What the film speaks unless someone says otherwise. The show is made in
 *  English and it is the only rendition these masters flag at all. */
export const DEFAULT_FILM_AUDIO_LANG = "en"

/**
 * Is this the narration track for blind viewers rather than a language?
 *
 * 101's master carries "English Audio Descriptions" under `LANGUAGE="en_ad"`,
 * with no accessibility tag to identify it — so it sorts immediately beside
 * plain English in any list, and someone will pick it by accident and be
 * completely baffled by what they hear. Recognised three ways because the
 * manifests are not consistent about which one they use.
 */
export function isDescriptionTrack(track: FilmAudioTrack): boolean {
  const chars = track.characteristics?.toLowerCase() ?? ""
  if (chars.includes("describes-video")) return true
  if (/(^|[_-])ad$/i.test(track.lang ?? "")) return true
  return /audio\s*description/i.test(track.name)
}

/** The renditions worth offering, in the order the manifest lists them. */
export function selectableAudioTracks(
  tracks: readonly FilmAudioTrack[],
): FilmAudioTrack[] {
  return tracks.filter((t) => !isDescriptionTrack(t))
}

/** "es-419" and "es-ES" are both Spanish. Split on the hyphen ONLY — the
 *  underscore in "en_ad" is not a region, and treating it as one would make a
 *  preference for English match the audio-description track. */
function base(lang: string | null | undefined): string {
  return (lang ?? "").trim().toLowerCase().split("-")[0] ?? ""
}

function exact(tracks: readonly FilmAudioTrack[], lang: string): FilmAudioTrack | undefined {
  const want = lang.trim().toLowerCase()
  return tracks.find((t) => (t.lang ?? "").trim().toLowerCase() === want)
}

function sameLanguage(tracks: readonly FilmAudioTrack[], lang: string): FilmAudioTrack | undefined {
  const want = base(lang)
  if (!want) return undefined
  return tracks.find((t) => base(t.lang) === want)
}

/**
 * The rendition to play, given what the user asked for.
 *
 * Falls through deliberately rather than failing: a film that has no Spanish
 * should play English, not silence, and a preference set on one episode must
 * not break the next one that happens to be dubbed into fewer languages.
 */
export function pickAudioTrack(
  tracks: readonly FilmAudioTrack[],
  preferredLang: string | null | undefined,
): FilmAudioTrack | null {
  const usable = selectableAudioTracks(tracks)
  if (usable.length === 0) return null
  if (preferredLang) {
    const asked = exact(usable, preferredLang) ?? sameLanguage(usable, preferredLang)
    if (asked) return asked
  }
  const english = exact(usable, DEFAULT_FILM_AUDIO_LANG) ?? sameLanguage(usable, DEFAULT_FILM_AUDIO_LANG)
  if (english) return english
  // The manifest's own opinion, where it has one, before the arbitrary answer.
  return usable.find((t) => t.default) ?? usable.find((t) => t.autoselect) ?? usable[0] ?? null
}

// ── Remembering the choice, per film (Sam, 2026-08-18) ────────────────────
//
// A browser preference rather than a synced setting: Sam weighed making it
// project-wide and chose not to — "I'd rather not introduce a new area for bugs
// to show up in" — so this is one person's choice on one machine.
//
// Keyed by the film's ADDRESS rather than by the file id, deliberately. The
// recording modal opens the same film through a different file, and keying by
// address is what makes the recorder follow the choice without either surface
// having to know the other exists. Per film rather than app-wide, also Sam's
// call: the language belongs to the project's footage, not to how someone likes
// to watch in general.

const FILM_AUDIO_LANG_PREFIX = "codex:video-audio-language:"

/** The language chosen for this film, or null for "nobody has said" — which
 *  `pickAudioTrack` reads as English. */
export function readFilmAudioLanguage(src: string | null | undefined): string | null {
  if (typeof window === "undefined" || !src) return null
  try {
    return window.localStorage.getItem(FILM_AUDIO_LANG_PREFIX + src)
  } catch {
    return null
  }
}

/** null forgets the choice, so the film goes back to English. */
export function writeFilmAudioLanguage(src: string | null | undefined, lang: string | null): void {
  if (typeof window === "undefined" || !src) return
  try {
    if (lang) window.localStorage.setItem(FILM_AUDIO_LANG_PREFIX + src, lang)
    else window.localStorage.removeItem(FILM_AUDIO_LANG_PREFIX + src)
  } catch {
    /* ignore persistence failures */
  }
}
