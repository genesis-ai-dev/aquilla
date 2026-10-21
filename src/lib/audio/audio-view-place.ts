// The Audio view's one place to play from. (AQU-1642 follow-up; Sam, 2026-10-17)
//
// In the Audio view the bottom bar's player is the only player. The bar, each
// verse card's corner button and the ⋯ menu's Play audio all drive it, so a
// verse never holds two places at once, and the card draws the place — moving
// while it plays, held while it waits. Sam's rules:
//
//   - Selecting a verse (clicking or tabbing into its row anywhere but its play
//     controls) sends the place to the start of that verse: the next Play,
//     wherever it is pressed, starts that verse from the top, even when
//     something was paused mid-way, in that verse or another. Selecting while
//     the run plays leaves it playing; the verse is where the next run starts.
//   - The card's corner button is Play, and Stop while the run is on its verse.
//     Stop ends the run, and that verse is where the next Play starts it.
//   - ⋯ Play audio is Play, and Pause while the run is on its verse: a pause
//     keeps the place.
//   - Play, from the card or ⋯, carries on from the place when it is in that
//     verse, and otherwise starts the verse from the top. The run plays on.
//   - A click inside a card's waveform puts the place there: the run plays on
//     from there if it was playing, and otherwise waits there.
//
// Pure: given where the run is, what one press does. The workspace hook
// (useAudioViewPlace) carries it out on the play queue.

/** Where the run is in this file, or null when it is idle (or elsewhere). */
export type RunOn = { cellId: string; kind: "playing" | "loading" | "paused" } | null

export type PlaceStep =
  | { kind: "none" }
  /** End the run. The verse becomes where the next Play starts. */
  | { kind: "stop" }
  | { kind: "pause" }
  | { kind: "resume" }
  /** Open the run at the verse — at a second of it, or where its kept audio starts. */
  | { kind: "start"; atSeconds?: number; play: boolean }
  /** Move within the verse the run is on. */
  | { kind: "seek"; atSeconds: number }

const sounding = (run: RunOn): boolean => run?.kind === "playing" || run?.kind === "loading"

/** Selecting a verse. A paused place, anywhere, gives way to the verse's start. */
export function placeOnSelect(run: RunOn): PlaceStep {
  return run?.kind === "paused" ? { kind: "stop" } : { kind: "none" }
}

/** The card's corner button: Play, or Stop while the run is on this verse. */
export function placeOnCardPress(run: RunOn, cellId: string): PlaceStep {
  if (run?.cellId === cellId) return sounding(run) ? { kind: "stop" } : { kind: "resume" }
  return { kind: "start", play: true }
}

/** ⋯ Play audio: Play, or Pause while the run is on this verse. */
export function placeOnMenuPress(run: RunOn, cellId: string): PlaceStep {
  if (run?.cellId === cellId) return sounding(run) ? { kind: "pause" } : { kind: "resume" }
  return { kind: "start", play: true }
}

/** A click inside the card's waveform, at a second of its clip. */
export function placeOnWaveformPick(run: RunOn, cellId: string, atSeconds: number): PlaceStep {
  if (run?.cellId === cellId) return { kind: "seek", atSeconds }
  return { kind: "start", atSeconds, play: sounding(run) }
}
