import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { createOpfsFs } from "@/lib/git/opfs-fs";
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles";
import { importFromOpfs } from "@/lib/importer/git-importer";
import { serializeFile } from "./file";
import { commitMetaEdit } from "@/lib/codex-editor/edits/commit-meta-edit";

const FIX = join(__dirname, "../../../../tests/fixtures/codex-editor");

describe("serializeFile", () => {
  it("round-trips byte-identical for an unmodified import", async () => {
    const root = new MemoryDirectoryHandle("r");
    const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle);
    await fs.promises.mkdir("/repo/files/target", { recursive: true });
    await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true });
    await fs.promises.writeFile("/repo/metadata.json", readFileSync(join(FIX, "metadata.json"), "utf8"));
    await fs.promises.writeFile("/repo/files/target/sample.codex", readFileSync(join(FIX, "sample.codex"), "utf8"));
    await fs.promises.writeFile(
      "/repo/.project/sourceTexts/sample.source",
      readFileSync(join(FIX, "sample.source"), "utf8"),
    );

    const { project, docs } = await importFromOpfs({
      fs,
      repoDir: "/repo",
      origin: {
        kind: "git",
        cloneUrl: "u",
        gitlabProjectId: 1,
        branch: "main",
        headSha: "abc",
        importedAt: "now",
      },
      permissions: {
        source: "gitlab",
        canEditContent: true,
        canEditComments: true,
        canResolveComments: true,
        canPush: true,
        accessLevel: 30,
      },
    });

    const doc = docs[project.files[0].id];
    const out = serializeFile(doc);
    const original = JSON.parse(readFileSync(join(FIX, "sample.codex"), "utf8"));
    expect(out).toEqual(original);
  });
});

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
