// Thin DOM layer for Google Drive import: lazy script loading, the GIS
// token popup, and the Picker dialog. Deliberately free of routing logic —
// everything decidable is in google-drive.ts where it can be unit tested.
// Scope is drive.file ONLY: access is limited to items the user picks,
// which keeps us out of Google's restricted-scope verification.

import type { DriveListPage, DrivePickedItem } from "./google-drive"
import { GOOGLE_FOLDER_MIME, googleAppIdFromClientId } from "./google-drive"

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"

// Minimal typings for the two Google globals we touch (no `any`).
interface GisTokenResponse {
  access_token?: string
  error?: string
}
interface GisTokenClient {
  requestAccessToken: () => void
}
interface PickerDoc {
  id: string
  name: string
  mimeType: string
}
interface PickerCallbackData {
  action: string
  docs?: PickerDoc[]
}
interface PickerBuilderish {
  addView: (view: unknown) => PickerBuilderish
  setAppId: (appId: string) => PickerBuilderish
  setOAuthToken: (token: string) => PickerBuilderish
  setDeveloperKey: (key: string) => PickerBuilderish
  enableFeature: (feature: string) => PickerBuilderish
  setCallback: (cb: (data: PickerCallbackData) => void) => PickerBuilderish
  build: () => { setVisible: (v: boolean) => void }
}
interface GoogleGlobal {
  accounts?: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string
        scope: string
        callback: (response: GisTokenResponse) => void
        error_callback?: (error: { type: string }) => void
      }) => GisTokenClient
    }
  }
  picker?: {
    Action: { PICKED: string; CANCEL: string }
    Feature: { MULTISELECT_ENABLED: string }
    ViewId: { DOCS: string }
    DocsView: new (viewId?: string) => {
      setIncludeFolders: (v: boolean) => unknown
      setSelectFolderEnabled: (v: boolean) => unknown
    }
    PickerBuilder: new () => PickerBuilderish
  }
}
interface GapiGlobal {
  load: (api: string, cb: () => void) => void
}

declare global {
  interface Window {
    google?: GoogleGlobal
    gapi?: GapiGlobal
  }
}

export function googleDriveConfig(): { clientId: string; apiKey: string } | null {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
  const apiKey = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined
  return clientId && apiKey ? { clientId, apiKey } : null
}

const loadedScripts = new Map<string, Promise<void>>()

function loadScript(src: string): Promise<void> {
  const existing = loadedScripts.get(src)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script")
    el.src = src
    el.async = true
    el.onload = () => resolve()
    el.onerror = () => {
      loadedScripts.delete(src)
      reject(new Error(`Failed to load ${src} — check your network and try again.`))
    }
    document.head.appendChild(el)
  })
  loadedScripts.set(src, promise)
  return promise
}

async function ensureGis(): Promise<NonNullable<GoogleGlobal["accounts"]>> {
  await loadScript("https://accounts.google.com/gsi/client")
  const accounts = window.google?.accounts
  if (!accounts) throw new Error("Google sign-in failed to initialize.")
  return accounts
}

async function ensurePicker(): Promise<NonNullable<GoogleGlobal["picker"]>> {
  const loaded = window.google?.picker
  if (loaded) return loaded
  await loadScript("https://apis.google.com/js/api.js")
  const gapi = window.gapi
  if (!gapi) throw new Error("Google Picker failed to initialize.")
  await new Promise<void>((resolve) => gapi.load("picker", resolve))
  const picker = window.google?.picker
  if (!picker) throw new Error("Google Picker failed to initialize.")
  return picker
}

export async function requestDriveAccessToken(clientId: string): Promise<string> {
  const accounts = await ensureGis()
  return new Promise<string>((resolve, reject) => {
    const client = accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.access_token) resolve(response.access_token)
        else reject(new Error(response.error ?? "Google sign-in was cancelled."))
      },
      error_callback: (error) => reject(new Error(`Google sign-in failed (${error.type}).`)),
    })
    client.requestAccessToken()
  })
}

export async function openDrivePicker(args: {
  accessToken: string
  apiKey: string
  clientId: string
}): Promise<DrivePickedItem[]> {
  // drive.file grants are keyed to the app ID: omit setAppId and the pick
  // never authorizes the app, so every subsequent download 404s.
  const appId = googleAppIdFromClientId(args.clientId)
  if (!appId) {
    throw new Error(
      "VITE_GOOGLE_CLIENT_ID doesn't look like a Google OAuth client ID " +
        "(expected <project-number>-….apps.googleusercontent.com).",
    )
  }
  const picker = await ensurePicker()
  return new Promise<DrivePickedItem[]>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
    view.setIncludeFolders(true)
    view.setSelectFolderEnabled(true)
    const dialog = new picker.PickerBuilder()
      .addView(view)
      .setAppId(appId)
      .setOAuthToken(args.accessToken)
      .setDeveloperKey(args.apiKey)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) {
          resolve((data.docs ?? []).map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType })))
        } else if (data.action === picker.Action.CANCEL) {
          resolve([])
        }
      })
      .build()
    dialog.setVisible(true)
  })
}

/** Curried Drive children lister for expandDriveFolders. */
export function listDriveChildren(
  accessToken: string,
): (folderId: string, pageToken?: string) => Promise<DriveListPage> {
  return async (folderId, pageToken) => {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: "100",
    })
    if (pageToken) params.set("pageToken", pageToken)
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new Error(`Listing the Drive folder failed (HTTP ${res.status}).`)
    const body = (await res.json()) as {
      files?: { id: string; name: string; mimeType: string }[]
      nextPageToken?: string
    }
    return {
      files: (body.files ?? []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })),
      nextPageToken: body.nextPageToken,
    }
  }
}

// Re-exported so the panel needs only this module for folder checks.
export { GOOGLE_FOLDER_MIME }
