// Why the Film panel's film failed, as the error card says it: no raw address
// (import map X-D-youtube-film-card, Nov 2: the card printed the watch address
// of a YouTube film, or an uploaded film's signed address with its token).

import type { MessageKey } from "@/lib/i18n/messages/en"
import { youTubeVideoId } from "@/lib/video/youtube"

/** Which film failed: a YouTube film (with the player's error code, when it
 *  gave one), one uploaded with this file, or one at a link. */
export type FilmFailure =
  | { kind: "youtube"; code: number | null; watchUrl: string }
  | { kind: "upload" }
  | { kind: "link"; host: string }

/** The YouTube iframe player's error codes
 *  (developers.google.com/youtube/iframe_api_reference#onError). */
export function youTubeFailureKey(code: number | null): MessageKey {
  if (code === 100) return "editor.timeline.videoPaneErrorYouTubeMissing"
  if (code === 101 || code === 150) return "editor.timeline.videoPaneErrorYouTubeNoEmbed"
  if (code === 2) return "editor.timeline.videoPaneErrorYouTubeBadLink"
  return "editor.timeline.videoPaneErrorYouTube"
}

/** What failed, from the stored address (an upload is `frontier-audio://`) and
 *  the played one (an upload plays from a signed address). A film at a link is
 *  named by its host. */
export function filmFailure(
  storedSrc: string,
  playedSrc: string,
  youTube: boolean,
  youTubeCode: number | null,
): FilmFailure {
  if (youTube) {
    const id = youTubeVideoId(playedSrc) ?? youTubeVideoId(storedSrc)
    return { kind: "youtube", code: youTubeCode, watchUrl: id ? `https://www.youtube.com/watch?v=${id}` : playedSrc }
  }
  if (storedSrc.startsWith("frontier-audio://")) return { kind: "upload" }
  try {
    return { kind: "link", host: new URL(storedSrc).host || storedSrc }
  } catch {
    return { kind: "link", host: storedSrc }
  }
}
