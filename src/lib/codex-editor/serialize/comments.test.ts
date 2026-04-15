import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOpfsFs } from "@/lib/git/opfs-fs";
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles";
import { importFromOpfs } from "@/lib/importer/git-importer";
import { serializeComments } from "./comments";

const FIX = join(__dirname, "../../../../tests/fixtures/codex-editor");

describe("serializeComments", () => {
  it("round-trips comments.json byte-equal when unchanged", async () => {
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
    await fs.promises.writeFile("/repo/.project/comments.json", readFileSync(join(FIX, "comments.json"), "utf8"));

    const { docs } = await importFromOpfs({
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

    const out = serializeComments(Object.values(docs));
    const original = JSON.parse(readFileSync(join(FIX, "comments.json"), "utf8"));
    expect(out).toEqual(original);
  });
});
