import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { serializeFile } from "./file";
import { commitMetaEdit } from "@/lib/codex-editor/edits/commit-meta-edit";

describe("serializeFile — meta.edits", () => {
  it("emits notebook-level edits from meta.edits Y.Array", () => {
    const doc = new Y.Doc()
    doc.getMap("meta").set("__source", { id: "n1", originalName: "n.codex" })
    commitMetaEdit(doc, ["videoUrl"], "https://example.com/a.mp4", "alice", "human")
    const out = serializeFile(doc)
    expect(out.metadata.edits).toHaveLength(1)
    expect(out.metadata.edits![0]).toEqual(expect.objectContaining({
      author: "alice",
      editMap: ["videoUrl"],
      value: "https://example.com/a.mp4",
    }))
    // FileEditHistory has no validatedBy:
    expect(out.metadata.edits![0].validatedBy).toBeUndefined()
  })
});
