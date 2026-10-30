// Test fixtures for AQU-2197: subtitle files whose times are video frame
// numbers written as hundredths of a second, shaped like Come and See's
// episode 101 VTT. Used by every VTT import path's tests.

const pad = (n: number, width = 2) => String(n).padStart(width, "0")
const clock = (sec: number, frame: number) =>
  `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}.${pad(frame)}0`

/** The cue every path's test reads: frame 15 of 00:01:06 written as .150.
 *  At 24 fps it belongs at 66.625 s, ending at 67.75 s; at 23.976 the whole
 *  label runs 0.1% slow, so frame 1,599 is at 66.692 s. */
export const SAMPLE_CUE = {
  text: "You should be sleeping, little one.",
  start: 66.15,
  end: 67.18,
  startAt24: 66.625,
  endAt24: 67.75,
  startAt23976: ((66 * 24 + 15) * 1001) / 24000,
  startAt25: 66.6,
}

/** A linked film's HLS master playlist, stating `fps` on its video variant
 *  the way the client's streams do (`FRAME-RATE=25.0`). */
export function filmMaster(fps: string): string {
  return "#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n"
    + `#EXT-X-STREAM-INF:BANDWIDTH=15965367,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=${fps}\n`
    + "video_h264_1280x720_fmp4.m3u8\n"
}

/** A `fetch` that serves `filmMaster(fps)` for any url, for tests that link a
 *  film to the file being imported into. */
export function filmFetch(fps: string) {
  return async () => ({ ok: true, text: async () => filmMaster(fps) }) as unknown as Response
}

/** A VTT of `n` cues (n ≥ 20) whose every time is a frame (0–23) written as
 *  hundredths; the third cue is `SAMPLE_CUE`. `srt` writes `,` fractions. */
export function framesAsHundredthsVtt(n = 24, { srt = false } = {}): string {
  const cues: string[] = []
  for (let i = 0; i < n; i++) {
    const [a, b, text] = i === 2
      ? ["00:01:06.150", "00:01:07.180", SAMPLE_CUE.text]
      : [clock(60 + i * 3, (i * 7) % 24), clock(62 + i * 3, (i * 5 + 3) % 24), `Line ${i + 1}.`]
    const range = srt ? `${a.replace(".", ",")} --> ${b.replace(".", ",")}` : `${a} --> ${b}`
    cues.push(srt ? `${i + 1}\n${range}\n${text}` : `line-${i + 1}\n${range}\n<v SPEAKER ${i % 3}>${text}</v>`)
  }
  return (srt ? "" : "WEBVTT\n\n") + cues.join("\n\n") + "\n"
}

/** The same cues properly timed to the millisecond: no warning expected. */
export function properlyTimedVtt(n = 24): string {
  const cues: string[] = []
  for (let i = 0; i < n; i++) {
    cues.push(`${i + 1}\n00:01:${pad(i)}.417 --> 00:01:${pad(i)}.833\nLine ${i + 1}.`)
  }
  return "WEBVTT\n\n" + cues.join("\n\n") + "\n"
}
