import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    const doc = docs[project.files[0].id];
    const cells = doc.getArray("cells").toJSON() as Array<{ original: string; translated: string }>;
    expect(cells).toHaveLength(2);
    expect(cells[0].original).toContain("In the beginning");
    expect(cells[0].translated).toContain("Im Anfang");
    const history = doc.getMap("history").toJSON() as Record<string, Array<{ author: string }>>;
    expect(history["GEN 1:1"]).toBeDefined();
    expect(history["GEN 1:1"][0].author).toBe("alice");
    const comments = doc.getMap("comments").toJSON() as Record<string, Array<{ messages: Array<{ text: string }> }>>;
    expect(comments["GEN 1:1"][0].messages[0].text).toContain("schuf");
    expect(project.permissions?.canEditContent).toBe(false);
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
