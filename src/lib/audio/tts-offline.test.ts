import { describe, expect, it } from "vitest"
import { ttsOfflineGate } from "./tts-offline"

describe("ttsOfflineGate", () => {
  it("never restricts generation while online", () => {
    expect(ttsOfflineGate({ offline: false, usesLocalModel: false, localModelReady: false })).toEqual({ kind: "ok" })
  })

  // A hosted engine can't run offline. Starting it anyway means a spinner,
  // then a network error, so it must be refused before it starts.
  it("blocks a hosted voice offline", () => {
    expect(ttsOfflineGate({ offline: true, usesLocalModel: false, localModelReady: false })).toEqual({
      kind: "blocked",
      suggestLocal: false,
    })
  })

  it("points at the on-device voice when it is downloaded", () => {
    expect(ttsOfflineGate({ offline: true, usesLocalModel: false, localModelReady: true })).toEqual({
      kind: "blocked",
      suggestLocal: true,
    })
  })

  // Saving needs an R2 upload, so the on-device voice offline must not
  // pretend to attach a clip. It plays a preview that is not saved.
  it("lets the on-device voice preview, unsaved, offline", () => {
    expect(ttsOfflineGate({ offline: true, usesLocalModel: true, localModelReady: true })).toEqual({ kind: "previewOnly" })
  })
})
