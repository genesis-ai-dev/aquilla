import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"

import { KnowledgeBaseSurface } from "./KnowledgeBaseSurface"
import type { KnowledgeDocument } from "@/lib/frontier/knowledge-base"

const api = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  content: vi.fn(),
  original: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  reindex: vi.fn(),
}))

vi.mock("@/lib/frontier/knowledge-base", () => {
  return {
    listKnowledgeDocuments: api.list,
    getKnowledgeDocument: api.detail,
    getKnowledgeDocumentContent: api.content,
    getKnowledgeDocumentOriginal: api.original,
    uploadKnowledgeDocument: api.upload,
    deleteKnowledgeDocument: api.remove,
    reindexKnowledgeDocument: api.reindex,
  }
})

const toastMock = vi.hoisted(() => ({ add: vi.fn() }))
vi.mock("@/components/ui/toast", () => ({
  toast: { add: toastMock.add, close: vi.fn() },
}))

function doc(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: "project-doc",
    orgId: null,
    projectId: "project-1",
    scope: "project",
    name: "style-guide.md",
    contentType: "text/markdown",
    sizeBytes: 2048,
    sha256: "abc",
    r2Key: "kb/project/project-1/project-doc",
    docSummary: "A concise style guide.",
    indexStatus: "ready",
    createdBy: "alice",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockResolvedValue([])
  api.detail.mockImplementation(async (_scope, _jwt, id) => ({
    doc: doc({ id }),
    tree: null,
  }))
  api.content.mockResolvedValue("Use formal language.")
  api.original.mockResolvedValue(new Blob(["original"]))
  api.upload.mockResolvedValue(doc({ id: "uploaded", name: "new.md", indexStatus: "pending" }))
  api.remove.mockResolvedValue(undefined)
  api.reindex.mockResolvedValue(undefined)
})

describe("KnowledgeBaseSurface", () => {
  it("shows inherited org documents as readable but not project-manageable", async () => {
    api.list.mockResolvedValue([
      doc(),
      doc({ id: "org-doc", projectId: null, orgId: 7, scope: "org", name: "org-guide.pdf" }),
    ])
    const onCheckedChange = vi.fn()

    render(
      <KnowledgeBaseSurface
        scope={{ kind: "project", id: "project-1" }}
        jwt="jwt"
        canManage
        drafting={{ checked: false, disabled: false, onCheckedChange }}
      />,
    )

    expect(await screen.findByText("style-guide.md")).toBeInTheDocument()
    const inheritedCard = screen.getByText("org-guide.pdf").closest('[data-slot="card"]')
    expect(inheritedCard).not.toBeNull()
    expect(within(inheritedCard as HTMLElement).getByText("Org")).toBeInTheDocument()
    expect(within(inheritedCard as HTMLElement).queryByRole("button", { name: "Delete document" }))
      .not.toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Delete document" })).toHaveLength(1)

    fireEvent.click(screen.getByRole("switch", { name: "Use knowledge base in drafting" }))
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })

  it("uploads a supported original and renders the returned pending document", async () => {
    const { container } = render(
      <KnowledgeBaseSurface scope={{ kind: "org", id: 7 }} jwt="jwt" canManage showTitle={false} />,
    )
    await screen.findByText("No knowledge documents yet")
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(["Reference"], "new.md", { type: "text/markdown" })

    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(api.upload).toHaveBeenCalledWith({ kind: "org", id: 7 }, "jwt", file))
    expect(await screen.findByText("new.md")).toBeInTheDocument()
    expect(screen.getByText("Indexing…")).toBeInTheDocument()
  })

  it("opens the extracted document content in an accessible dialog", async () => {
    api.list.mockResolvedValue([doc()])
    render(<KnowledgeBaseSurface scope={{ kind: "project", id: "project-1" }} jwt="jwt" canManage />)

    fireEvent.click(await screen.findByRole("button", { name: "View document" }))

    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(await screen.findByText("Use formal language.")).toBeInTheDocument()
    expect(api.detail).toHaveBeenCalledWith({ kind: "project", id: "project-1" }, "jwt", "project-doc")
    expect(api.content).toHaveBeenCalledWith({ kind: "project", id: "project-1" }, "jwt", "project-doc")
  })

  it("requires confirmation before deleting an org document", async () => {
    api.list.mockResolvedValue([doc({ scope: "org", projectId: null, orgId: 7 })])
    render(<KnowledgeBaseSurface scope={{ kind: "org", id: 7 }} jwt="jwt" canManage />)

    fireEvent.click(await screen.findByRole("button", { name: "Delete document" }))
    const alert = await screen.findByRole("alertdialog")
    expect(within(alert).getByText("Delete style-guide.md?")).toBeInTheDocument()
    fireEvent.click(within(alert).getByRole("button", { name: "Delete document" }))

    await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ kind: "org", id: 7 }, "jwt", "project-doc"))
    await waitFor(() => expect(screen.queryByText("style-guide.md")).not.toBeInTheDocument())
  })
})
