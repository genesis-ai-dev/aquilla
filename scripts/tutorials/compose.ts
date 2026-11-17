/**
 * Puts one tutorial video together: the opening card, the take inside the
 * Aquilla frame, the closing card, and each line's voice at the moment the
 * take held for it, evened to -16 LUFS. Pure functions build the plan and the
 * ffmpeg arguments (tested in tutorials.test.ts); `compose` runs them.
 */
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import type { CardPaths } from "./cards"
import { BRAND, CANVAS, FADE_MS, INTRO_MS, OUTRO_MS, WINDOW } from "./brand"

export interface TakeLine {
  key: string
  text: string
  t: number
  ms: number
  voiced: boolean
}

export interface Take {
  id: string
  /** The recording, a .webm. */
  video: string
  /** What to cut off its front: the sign-in before the take began. */
  preludeMs: number
  /** The take's own length, after the prelude. */
  durationMs: number
  lines: TakeLine[]
}

/** A line's voice file, by the line's key. A line without one is silent. */
export type VoiceFiles = Record<string, string>

const seconds = (ms: number): string => (ms / 1000).toFixed(3)

export function totalMs(take: Take): number {
  return INTRO_MS + take.durationMs + OUTRO_MS
}

function vttTime(ms: number): string {
  const whole = Math.max(0, Math.round(ms))
  const h = Math.floor(whole / 3_600_000)
  const m = Math.floor((whole % 3_600_000) / 60_000)
  const s = Math.floor((whole % 60_000) / 1000)
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0")
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(whole % 1000, 3)}`
}

/** The captions track: each line from when it is said to when the next begins. */
export function buildVtt(take: Take): string {
  const cues = take.lines.map((line, index) => {
    const start = INTRO_MS + line.t
    const next = take.lines[index + 1]
    const end = Math.min(start + line.ms, next ? INTRO_MS + next.t : INTRO_MS + take.durationMs)
    return `${index + 1}\n${vttTime(start)} --> ${vttTime(end)}\n${line.text}`
  })
  return `WEBVTT\n\n${cues.join("\n\n")}\n`
}

/** The ffmpeg arguments for one video. */
export function composeArgs(take: Take, cards: CardPaths, voice: VoiceFiles, out: string): string[] {
  const fade = seconds(FADE_MS)
  const main = seconds(take.durationMs)
  const voiced = take.lines.filter((line) => voice[line.key])
  const inputs = [
    "-i", take.video,
    "-loop", "1", "-framerate", String(CANVAS.fps), "-i", cards.frame,
    "-loop", "1", "-framerate", String(CANVAS.fps), "-i", cards.intro,
    "-loop", "1", "-framerate", String(CANVAS.fps), "-i", cards.outro,
    "-f", "lavfi", "-i", `color=c=${BRAND.ink}:s=${CANVAS.width}x${CANVAS.height}:r=${CANVAS.fps}`,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    ...voiced.flatMap((line) => ["-i", voice[line.key]]),
  ]
  const FIRST_VOICE = 6

  const video = [
    // The take, without the sign-in, at the window's size.
    `[0:v]trim=start=${seconds(take.preludeMs)}:duration=${main},setpts=PTS-STARTPTS,fps=${CANVAS.fps},` +
      `scale=${WINDOW.width}:${WINDOW.height}:flags=lanczos,setsar=1[app]`,
    `[4:v]trim=duration=${main},setpts=PTS-STARTPTS[bg]`,
    `[bg][app]overlay=${WINDOW.x}:${WINDOW.y}:eof_action=repeat[under]`,
    // The frame goes on top: its window is see-through and has the round corners.
    `[1:v]trim=duration=${main},setpts=PTS-STARTPTS[frame]`,
    `[under][frame]overlay=0:0,fade=t=in:st=0:d=${fade},fade=t=out:st=${seconds(take.durationMs - FADE_MS)}:d=${fade},setsar=1[main]`,
    `[2:v]trim=duration=${seconds(INTRO_MS)},setpts=PTS-STARTPTS,fade=t=out:st=${seconds(INTRO_MS - FADE_MS)}:d=${fade},setsar=1[intro]`,
    `[3:v]trim=duration=${seconds(OUTRO_MS)},setpts=PTS-STARTPTS,fade=t=in:st=0:d=${fade},setsar=1[outro]`,
    `[intro][main][outro]concat=n=3:v=1:a=0,format=yuv420p[v]`,
  ]

  const total = seconds(totalMs(take))
  const audio =
    voiced.length === 0
      ? [`[5:a]atrim=duration=${total}[a]`]
      : [
          ...voiced.map((line, index) => {
            const at = INTRO_MS + line.t
            return `[${FIRST_VOICE + index}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${at}|${at}[say${index}]`
          }),
          `[5:a]atrim=duration=${total}[bed]`,
          `[bed]${voiced.map((_, index) => `[say${index}]`).join("")}amix=inputs=${voiced.length + 1}:duration=first:normalize=0,` +
            `loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`,
        ]

  return [
    "-y", "-hide_banner", "-loglevel", "error",
    ...inputs,
    "-filter_complex", [...video, ...audio].join(";"),
    "-map", "[v]", "-map", "[a]",
    "-r", String(CANVAS.fps),
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    // BT.709 and square pixels, as scripts/assemble-showcase.ts tags its MP4s:
    // an untagged one is taken for SD by some players and its edges cropped.
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-b:a", "128k",
    "-t", total,
    "-movflags", "+faststart",
    out,
  ]
}

function ffmpeg(args: string[], what: string): void {
  const run = spawnSync("ffmpeg", args, { encoding: "utf8" })
  if (run.error) throw new Error(`${what}: ffmpeg did not start (${run.error.message}). Install ffmpeg.`)
  if (run.status !== 0) throw new Error(`${what}: ffmpeg failed.\n${run.stderr}`)
}

export interface Composed {
  mp4: string
  poster: string
  captions: string
}

/** Make `<base>.mp4`, `<base>.jpg` (the opening card) and `<base>.en.vtt`. */
export function compose(take: Take, cards: CardPaths, voice: VoiceFiles, base: string): Composed {
  const made: Composed = { mp4: `${base}.mp4`, poster: `${base}.jpg`, captions: `${base}.en.vtt` }
  ffmpeg(composeArgs(take, cards, voice, made.mp4), `compose ${take.id}`)
  ffmpeg(["-y", "-hide_banner", "-loglevel", "error", "-i", cards.intro, "-q:v", "3", made.poster], `poster ${take.id}`)
  writeFileSync(made.captions, buildVtt(take))
  return made
}

/** A media file's length, read from ffmpeg's own report (no ffprobe needed). */
export function mediaMs(file: string): number {
  const report = spawnSync("ffmpeg", ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr ?? ""
  const found = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(report)
  if (!found) throw new Error(`Could not read the length of ${file}`)
  return Math.round((Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3])) * 1000)
}
