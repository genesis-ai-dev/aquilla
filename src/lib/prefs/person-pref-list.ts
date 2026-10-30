/**
 * person-pref-list — every preference that follows the person (AQU-2264).
 *
 * One entry per preference: its key in the person's server record, the
 * browser key this device has always kept it under (still used when signed
 * out, unchanged, so a signed-out device behaves exactly as before), its
 * default, and how each side stores it. Importing this file registers them
 * all, which is what lets the first sync give a person every value at once.
 *
 * The recorder modules (`src/lib/store/recording-*-pref.ts`) and the
 * timeline's snap and follow keep their own exports and read through these.
 * To add one: define it here, then read it through `usePersonPref` / `.get()`.
 * (The read-through branch's three — Read-through, its format, and "Hear the
 * line before" — belong here too when it lands.)
 */

import type { CountdownSpeed } from "@/lib/store/recording-countdown-pref"
import type { RecordingFormat } from "@/lib/store/recording-format-pref"
import { definePersonPref, type PersonPrefSpec } from "./person-prefs"

const asBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)

/** A switch that is ON unless the device key holds `offText`. */
function onByDefault(serverKey: string, deviceKey: string, offText: string): PersonPrefSpec<boolean> {
  return {
    serverKey,
    deviceKey,
    defaultValue: true,
    parse: asBoolean,
    toDevice: (on) => (on ? null : offText),
    fromDevice: (raw) => raw !== offText,
  }
}

/** A switch that is OFF unless the device key holds "on". */
function offByDefault(serverKey: string, deviceKey: string): PersonPrefSpec<boolean> {
  return {
    serverKey,
    deviceKey,
    defaultValue: false,
    parse: asBoolean,
    toDevice: (on) => (on ? "on" : null),
    fromDevice: (raw) => raw === "on",
  }
}

const COUNTDOWN_SPEEDS = new Set<string>(["off", "fast", "normal", "slow"])

// ── The recorder ─────────────────────────────────────────────────────────

/** Recorder ⚙ → Countdown: Off, Fast, Normal, Slow. The device stores only a
 *  departure from Normal, under the key the old on/off switch used. */
export const recorderCountdownPref = definePersonPref<CountdownSpeed>({
  serverKey: "recorder.countdown",
  deviceKey: "aq.recording-countdown.v1",
  defaultValue: "normal",
  parse: (value) => (typeof value === "string" && COUNTDOWN_SPEEDS.has(value) ? (value as CountdownSpeed) : undefined),
  toDevice: (speed) => (speed === "normal" ? null : speed),
  fromDevice: (raw) => (raw === "off" || raw === "fast" || raw === "slow" ? raw : "normal"),
})

/** Recorder ⚙ → Countdown beep. Was never remembered before AQU-2264. */
export const recorderCountdownBeepPref = definePersonPref(
  onByDefault("recorder.countdownBeep", "aq.recording-countdown-beep.v1", "off"),
)

/** Recorder ⚙ → Move on after saving a recording. */
export const recorderMoveOnAfterSavingPref = definePersonPref(
  onByDefault("recorder.moveOnAfterSaving", "aq.recording-auto-advance.v1", "off"),
)

/** Recorder ⚙ → Keep the takes drawer open. */
export const recorderKeepTakesDrawerOpenPref = definePersonPref(
  onByDefault("recorder.keepTakesDrawerOpen", "aq.recording-takes-drawer.v1", "closed"),
)

/** The recorder's WAV / COMPRESSED button: the format a take is captured in. */
export const recorderFormatPref = definePersonPref<RecordingFormat>({
  serverKey: "recorder.format",
  deviceKey: "aq.recording-format.v1",
  defaultValue: "wav",
  parse: (value) => (value === "wav" || value === "webm" ? value : undefined),
  toDevice: (format) => (format === "webm" ? "webm" : null),
  fromDevice: (raw) => (raw === "webm" ? "webm" : "wav"),
})

/** The film's mute button in the recorder (headphones only). */
export const recorderFilmAudiblePref = definePersonPref(
  offByDefault("recorder.filmAudible", "aq.recording-film-audible.v1"),
)

/** The recorder's "Collapse video" / "Video" buttons: the narrow recorder. */
export const recorderFilmCollapsedPref = definePersonPref(
  offByDefault("recorder.filmCollapsed", "aq.recording-video-collapsed.v1"),
)

// ── The timeline ─────────────────────────────────────────────────────────

/** Timeline toolbar → Follow playhead. Was never remembered before AQU-2264. */
export const timelineFollowPlayheadPref = definePersonPref(
  onByDefault("timeline.followPlayhead", "aq.timeline-follow-playhead.v1", "off"),
)

/** Timeline toolbar → Snap to neighboring edges. The device key has always
 *  stored "on" or "off" explicitly. */
export const timelineSnapPref = definePersonPref<boolean>({
  serverKey: "timeline.snap",
  deviceKey: "aquilla:timelineSnap",
  defaultValue: true,
  parse: asBoolean,
  toDevice: (on) => (on ? "on" : "off"),
  fromDevice: (raw) => raw !== "off",
})
