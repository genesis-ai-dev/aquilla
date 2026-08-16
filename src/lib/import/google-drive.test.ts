// Routing, folder expansion, and byte fetching for the Google Drive importer.
// Loud-drop invariant: every input item lands in either accepted or skipped.

import { describe, it, expect, vi } from "vitest"
import {
  planDriveImport,
  expandDriveFolders,
  fetchDriveFile,
  driveOrigin,
  googleAppIdFromClientId,
  MAX_DRIVE_IMPORT_FILES,
  GOOGLE_FOLDER_MIME,
  type DrivePickedItem,
} from "./google-drive"

const item = (over: Partial<DrivePickedItem>): DrivePickedItem => ({
  id: "f1", name: "doc.txt", mimeType: "text/plain", ...over,
})

describe("planDriveImport", () => {
  it("routes native Google Docs to DOCX export and appends .docx", () => {
    const plan = planDriveImport([
      item({ id: "d1", name: "My Draft", mimeType: "application/vnd.google-apps.document" }),
    ])
    expect(plan.accepted).toEqual([
      { id: "d1", name: "My Draft.docx", mimeType: "application/vnd.google-apps.document", action: "export-docx" },
    ])
    expect(plan.skipped).toEqual([])
  })

  it("keeps an existing .docx suffix on exported Docs", () => {
    const plan = planDriveImport([
      item({ name: "Draft.docx", mimeType: "application/vnd.google-apps.document" }),
    ])
    expect(plan.accepted[0].name).toBe("Draft.docx")
  })

  it("skips Sheets and Slides loudly with a workaround reason", () => {
    const plan = planDriveImport([
      item({ name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" }),
      item({ name: "Deck", mimeType: "application/vnd.google-apps.presentation" }),
    ])
    expect(plan.accepted).toEqual([])
    expect(plan.skipped).toEqual([
      { name: "Budget", reason: "Google Sheets aren't supported yet — download as .xlsx and upload it instead." },
      { name: "Deck", reason: "Google Slides aren't supported yet — download as .pptx and upload it instead." },
    ])
  })

  it("skips other native Google types with a generic reason", () => {
    const plan = planDriveImport([
      item({ name: "Survey", mimeType: "application/vnd.google-apps.form" }),
    ])
    expect(plan.skipped).toEqual([
      { name: "Survey", reason: "This Google file type can't be imported." },
    ])
  })

  it("accepts regular files whose extension the pipeline supports", () => {
    const plan = planDriveImport([
      item({ id: "u1", name: "GEN.usfm", mimeType: "application/octet-stream" }),
      item({ id: "u2", name: "notes.md", mimeType: "text/markdown" }),
    ])
    expect(plan.accepted.map((t) => t.action)).toEqual(["download", "download"])
    expect(plan.skipped).toEqual([])
  })

  it("skips unsupported extensions loudly, naming the extension", () => {
    const plan = planDriveImport([item({ name: "scan.pdf", mimeType: "application/pdf" })])
    expect(plan.skipped).toEqual([
      { name: "scan.pdf", reason: "Unsupported file type (.pdf)." },
    ])
  })

  it("never drops an item silently: accepted + skipped covers every non-folder input", () => {
    const items = [
      item({ id: "a", name: "a.txt" }),
      item({ id: "b", name: "b.xyz" }),
      item({ id: "c", name: "Doc", mimeType: "application/vnd.google-apps.document" }),
    ]
    const plan = planDriveImport(items)
    expect(plan.accepted.length + plan.skipped.length).toBe(items.length)
  })
})

describe("expandDriveFolders", () => {
  const folder = (id: string, name = id): DrivePickedItem => ({
    id, name, mimeType: GOOGLE_FOLDER_MIME,
  })

  it("passes plain files through and expands folders recursively with pagination", async () => {
    const pages: Record<string, { files: DrivePickedItem[]; nextPageToken?: string }[]> = {
      root: [
        { files: [item({ id: "x", name: "x.txt" }), folder("sub")], nextPageToken: "p2" },
        { files: [item({ id: "y", name: "y.txt" })] },
      ],
      sub: [{ files: [item({ id: "z", name: "z.txt" })] }],
    }
    const calls: string[] = []
    const listChildren = vi.fn(async (folderId: string, pageToken?: string) => {
      calls.push(`${folderId}:${pageToken ?? ""}`)
      const queue = pages[folderId]
      return pageToken === "p2" ? queue[1] : queue[0]
    })
    const out = await expandDriveFolders([item({ id: "top", name: "top.md" }), folder("root")], listChildren)
    expect(out.map((f) => f.id).sort()).toEqual(["top", "x", "y", "z"])
    expect(calls).toContain("root:p2")
  })

  it("throws a loud error past the file cap instead of truncating", async () => {
    const many = Array.from({ length: MAX_DRIVE_IMPORT_FILES + 1 }, (_, i) =>
      item({ id: `f${i}`, name: `f${i}.txt` }),
    )
    const listChildren = vi.fn(async () => ({ files: many }))
    await expect(expandDriveFolders([folder("big")], listChildren)).rejects.toThrow(
      /more than 500 files/i,
    )
  })
})

describe("fetchDriveFile", () => {
  it("downloads regular files via alt=media with the bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(["hello"]), { status: 200 }))
    const file = await fetchDriveFile(
      { id: "f9", name: "a.txt", mimeType: "text/plain", action: "download" },
      "tok-1",
      fetchImpl as unknown as typeof fetch,
    )
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://www.googleapis.com/drive/v3/files/f9?alt=media")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1")
    expect(file.name).toBe("a.txt")
    expect(await file.text()).toBe("hello")
  })

  it("exports native Docs as DOCX via the export endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(["bytes"]), { status: 200 }))
    await fetchDriveFile(
      { id: "d1", name: "Draft.docx", mimeType: "application/vnd.google-apps.document", action: "export-docx" },
      "tok-1",
      fetchImpl as unknown as typeof fetch,
    )
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url).toBe(
      "https://www.googleapis.com/drive/v3/files/d1/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document",
    )
  })

  it("surfaces HTTP failures with the file name and status", async () => {
    const fetchImpl = vi.fn(async () => new Response("too big", { status: 403 }))
    await expect(
      fetchDriveFile(
        { id: "d1", name: "Huge.docx", mimeType: "application/vnd.google-apps.document", action: "export-docx" },
        "tok-1",
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/Huge\.docx.*403/)
  })
})

describe("googleAppIdFromClientId", () => {
  it("extracts the project-number prefix of an OAuth client ID", () => {
    expect(googleAppIdFromClientId("123456789012-h5xyz.apps.googleusercontent.com")).toBe(
      "123456789012",
    )
  })

  it("returns null for strings without a numeric prefix", () => {
    expect(googleAppIdFromClientId("bogus.apps.googleusercontent.com")).toBe(null)
    expect(googleAppIdFromClientId("")).toBe(null)
  })
})

describe("driveOrigin", () => {
  it("records provider, id, mimeType, and export marker", () => {
    expect(
      driveOrigin({ id: "d1", name: "Draft.docx", mimeType: "application/vnd.google-apps.document", action: "export-docx" }),
    ).toEqual({ provider: "google-drive", driveFileId: "d1", mimeType: "application/vnd.google-apps.document", exportedAs: "docx" })
    expect(
      driveOrigin({ id: "f2", name: "a.txt", mimeType: "text/plain", action: "download" }),
    ).toEqual({ provider: "google-drive", driveFileId: "f2", mimeType: "text/plain" })
  })
})
