import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOpfsFs } from "@/lib/git/opfs-fs";
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles";
import { importFromOpfs } from "@/lib/importer/git-importer";
import { serializeFile, serializeComments } from "@/lib/codex-editor/serialize";

const FIX = join(__dirname, "../fixtures/codex-editor");

describe("full round-trip lossless", () => {
  it("clone -> import -> noop -> serialize is byte-identical", async () => {
    const root = new MemoryDirectoryHandle("r");
    const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle);
    await fs.promises.mkdir("/r/files/target", { recursive: true });
    await fs.promises.mkdir("/r/.project/sourceTexts", { recursive: true });
    const codex = readFileSync(join(FIX, "full-roundtrip.codex"), "utf8");
    const source = readFileSync(join(FIX, "full-roundtrip.source"), "utf8");
    const meta = readFileSync(join(FIX, "full-roundtrip-metadata.json"), "utf8");
    const comments = readFileSync(join(FIX, "full-roundtrip-comments.json"), "utf8");
    await fs.promises.writeFile("/r/files/target/full-roundtrip.codex", codex);
    await fs.promises.writeFile("/r/.project/sourceTexts/full-roundtrip.source", source);
    await fs.promises.writeFile("/r/metadata.json", meta);
    await fs.promises.writeFile("/r/.project/comments.json", comments);

    const { project, docs } = await importFromOpfs({
      fs,
      repoDir: "/r",
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
    expect(serializeFile(doc)).toEqual(JSON.parse(codex));
    expect(serializeComments([doc])).toEqual(JSON.parse(comments));
  });
});
