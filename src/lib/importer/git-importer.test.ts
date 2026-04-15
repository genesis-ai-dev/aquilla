import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { createOpfsFs } from "@/lib/git/opfs-fs";
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles";
import { importFromOpfs, persistImportedProject } from "./git-importer";
import { listProjects } from "@/lib/store/project-index";

const FIX = join(__dirname, "../../../tests/fixtures/codex-editor");

function readFix(name: string) { return readFileSync(join(FIX, name), "utf8"); }

describe("importFromOpfs", () => {
  it("builds a ProjectRecord and Y.Docs from codex-editor files", async () => {
    const root = new MemoryDirectoryHandle("r");
    const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle);
    await fs.promises.mkdir("/repo/files/target", { recursive: true });
    await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true });
    await fs.promises.writeFile("/repo/metadata.json", readFix("metadata.json"));
    await fs.promises.writeFile("/repo/files/target/sample.codex", readFix("sample.codex"));
    await fs.promises.writeFile("/repo/.project/sourceTexts/sample.source", readFix("sample.source"));
    await fs.promises.writeFile("/repo/.project/comments.json", readFix("comments.json"));

    const { project, docs } = await importFromOpfs({
      fs, repoDir: "/repo",
      origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
      permissions: { source: "gitlab", canEditContent: false, canEditComments: true, canResolveComments: false, canPush: false, accessLevel: 20 },
    });

    expect(project.name).toBe("Sample Genesis");
    expect(project.sourceLanguage).toBe("en");
    expect(project.targetLanguage).toBe("de");
    expect(project.files).toHaveLength(1);
    expect(project.files[0].type).toBe("usfm"); // GEN 1:1 context => scripture
    const doc = docs[project.files[0].id];
    const cellsMap = doc.getMap("cells");
    const order = doc.getArray<string>("order").toArray();
    expect(order).toEqual(["GEN 1:1", "GEN 1:2"]);
    const cell1 = cellsMap.get("GEN 1:1") as Y.Map<unknown>;
    expect(cell1.get("original")).toContain("In the beginning");
    const histArr = cell1.get("history") as Y.Array<{ author: string }>;
    expect(histArr.toArray()[0].author).toBe("alice");
    const threadsArr = cell1.get("threads") as Y.Array<Y.Map<unknown>>;
    expect(threadsArr.length).toBe(1);
    const t0 = threadsArr.get(0);
    const messages = t0.get("messages") as Array<{ text: string }>;
    expect(messages[0].text).toContain("schuf");
    expect(project.permissions?.canEditContent).toBe(false);
  });
});

describe("importFromOpfs __source stashing", () => {
  it("stashes __source on every cell, on file metadata, and on threads", async () => {
    const root = new MemoryDirectoryHandle("r");
    const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle);
    await fs.promises.mkdir("/repo/files/target", { recursive: true });
    await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true });
    await fs.promises.writeFile("/repo/metadata.json", readFix("metadata.json"));
    await fs.promises.writeFile("/repo/files/target/sample.codex", readFix("sample.codex"));
    await fs.promises.writeFile("/repo/.project/sourceTexts/sample.source", readFix("sample.source"));
    await fs.promises.writeFile("/repo/.project/comments.json", readFix("comments.json"));

    const { project, docs } = await importFromOpfs({
      fs, repoDir: "/repo",
      origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
      permissions: { source: "gitlab", canEditContent: true, canEditComments: true, canResolveComments: true, canPush: true, accessLevel: 30 },
    });

    const doc = docs[project.files[0].id];
    const cellsMap = doc.getMap("cells");
    const cell1 = cellsMap.get("GEN 1:1") as Y.Map<unknown>;
    const cellSource = cell1.get("__source") as Record<string, unknown>;
    expect(cellSource).toBeDefined();
    expect(cellSource.metadata).toBeDefined();

    const meta = doc.getMap("meta");
    expect(meta.get("__source")).toBeDefined();

    const threadsArr = cell1.get("threads") as Y.Array<Y.Map<unknown>>;
    expect(threadsArr.get(0).get("__source")).toBeDefined();
  });
});

describe("persistImportedProject", () => {
  it("persists the imported project into the project index", async () => {
    const root = new MemoryDirectoryHandle("r");
    const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle);
    await fs.promises.mkdir("/repo/files/target", { recursive: true });
    await fs.promises.writeFile("/repo/metadata.json", readFix("metadata.json"));
    await fs.promises.writeFile("/repo/files/target/sample.codex", readFix("sample.codex"));

    const imported = await importFromOpfs({
      fs, repoDir: "/repo",
      origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
      permissions: { source: "gitlab", canEditContent: false, canEditComments: false, canResolveComments: false, canPush: false },
    });
    await persistImportedProject(imported);

    const all = await listProjects();
    expect(all.find(p => p.id === imported.project.id)?.name).toBe("Sample Genesis");
  });
});
