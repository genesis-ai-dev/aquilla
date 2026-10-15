// What audio generation may do while the device is offline. Every save path
// needs the server: Inworld synthesizes server-side, Gemini is a hosted API,
// and even the on-device MMS voice uploads its clip to R2 before attaching it.
// The on-device voice can still synthesize and PLAY without a connection, so
// offline it degrades to an unsaved preview instead of failing halfway.
export type TtsOfflineGate =
  | { kind: "ok" }
  /** On-device voice: synthesize and play, don't save. */
  | { kind: "previewOnly" }
  /** Can't run. `suggestLocal`: the on-device voice is downloaded and could
   *  preview this line if the voice were switched to it. */
  | { kind: "blocked"; suggestLocal: boolean }

export function ttsOfflineGate(s: {
  offline: boolean
  /** The voice that would run is the on-device model. */
  usesLocalModel: boolean
  /** The on-device model's weights are on this device. */
  localModelReady: boolean
}): TtsOfflineGate {
  if (!s.offline) return { kind: "ok" }
  if (s.usesLocalModel) return { kind: "previewOnly" }
  return { kind: "blocked", suggestLocal: s.localModelReady }
}
