import { describe, it, expect, beforeEach } from "vitest";
import { createOpfsFs } from "@/lib/git/opfs-fs";
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles";
import { listFilesMatching } from "./opfs-paths";

describe("listFilesMatching", () => {
  let root: MemoryDirectoryHandle;
  beforeEach(() => { root = new MemoryDirectoryHandle("r"); });

  it("finds files matching an extension recursively", async () => {
    const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle);
    await fs.promises.mkdir("/files/target", { recursive: true });
    await fs.promises.writeFile("/files/target/a.codex", "{}");
    await fs.promises.writeFile("/files/target/b.codex", "{}");
    await fs.promises.writeFile("/files/target/c.txt", "{}");

    const found = await listFilesMatching(fs, "/", /\.codex$/);
    expect(found.sort()).toEqual(["/files/target/a.codex", "/files/target/b.codex"]);
  });
});
