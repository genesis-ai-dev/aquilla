// Picker dialog wiring. Regression for AQU-823: with the drive.file scope the
// Picker must carry the app ID (Cloud project number) — without setAppId a
// pick never grants the app access and every follow-up download 404s.

import { describe, it, expect, afterEach, vi } from "vitest"
import { openDrivePicker } from "./google-drive-picker"

interface RecordedPicker {
  appId?: string
  token?: string
  key?: string
  features: string[]
  callback?: (data: {
    action: string
    docs?: { id: string; name: string; mimeType: string }[]
  }) => void
  visible?: boolean
}

/** Installs a window.google.picker fake that records the builder chain. */
function installFakePicker(): RecordedPicker {
  const recorded: RecordedPicker = { features: [] }
  const builder = {
    addView: () => builder,
    setAppId: (appId: string) => {
      recorded.appId = appId
      return builder
    },
    setOAuthToken: (token: string) => {
      recorded.token = token
      return builder
    },
    setDeveloperKey: (key: string) => {
      recorded.key = key
      return builder
    },
    enableFeature: (feature: string) => {
      recorded.features.push(feature)
      return builder
    },
    setCallback: (cb: NonNullable<RecordedPicker["callback"]>) => {
      recorded.callback = cb
      return builder
    },
    build: () => ({
      setVisible: (v: boolean) => {
        recorded.visible = v
      },
    }),
  }
  window.google = {
    picker: {
      Action: { PICKED: "picked", CANCEL: "cancel" },
      Feature: { MULTISELECT_ENABLED: "multiselect" },
      ViewId: { DOCS: "docs" },
      DocsView: class {
        setIncludeFolders() {}
        setSelectFolderEnabled() {}
      },
      // A constructor returning an object makes `new` yield that object.
      PickerBuilder: function PickerBuilder() {
        return builder
      },
    },
  } as unknown as Window["google"]
  return recorded
}

afterEach(() => {
  window.google = undefined
})

describe("openDrivePicker", () => {
  it("stamps the app ID (project number), OAuth token, and API key onto the dialog", async () => {
    const recorded = installFakePicker()
    const promise = openDrivePicker({
      accessToken: "tok-1",
      apiKey: "key-1",
      clientId: "123456789012-abc.apps.googleusercontent.com",
    })
    await vi.waitFor(() => expect(recorded.callback).toBeDefined())
    recorded.callback?.({
      action: "picked",
      docs: [{ id: "f1", name: "qa-process.md", mimeType: "text/markdown" }],
    })
    await expect(promise).resolves.toEqual([
      { id: "f1", name: "qa-process.md", mimeType: "text/markdown" },
    ])
    expect(recorded.appId).toBe("123456789012")
    expect(recorded.token).toBe("tok-1")
    expect(recorded.key).toBe("key-1")
    expect(recorded.visible).toBe(true)
  })

  it("fails loudly when the client ID has no project-number prefix", async () => {
    installFakePicker()
    await expect(
      openDrivePicker({ accessToken: "t", apiKey: "k", clientId: "bogus" }),
    ).rejects.toThrow(/doesn't look like a Google OAuth client ID/)
  })
})
