import { describe, it, expect, beforeEach } from "vitest";
import { createOpfsFs } from "./opfs-fs";
import { MemoryDirectoryHandle } from "./__test__/mem-fs-handles";

describe("opfs-fs", () => {
  let root: MemoryDirectoryHandle;
  beforeEach(() => {
    root = new MemoryDirectoryHandle("root");
  });

  it("writes and reads a file", async () => {
    const fs = createOpfsFs(root as any);
    await fs.promises.mkdir("/a");
    await fs.promises.writeFile("/a/b.txt", "hello");
    const out = await fs.promises.readFile("/a/b.txt", { encoding: "utf8" });
    expect(out).toBe("hello");
  });

  it("stat reports isFile / isDirectory", async () => {
    const fs = createOpfsFs(root as any);
    await fs.promises.mkdir("/d");
    await fs.promises.writeFile("/d/f", "x");
    const s = await fs.promises.stat("/d/f");
    expect(s.isFile()).toBe(true);
    const ds = await fs.promises.stat("/d");
    expect(ds.isDirectory()).toBe(true);
  });

  it("readdir lists children", async () => {
    const fs = createOpfsFs(root as any);
    await fs.promises.mkdir("/x");
    await fs.promises.writeFile("/x/a", "1");
    await fs.promises.writeFile("/x/b", "2");
    expect((await fs.promises.readdir("/x")).sort()).toEqual(["a", "b"]);
  });

  it("unlink removes files", async () => {
    const fs = createOpfsFs(root as any);
    await fs.promises.writeFile("/f", "x");
    await fs.promises.unlink("/f");
    await expect(fs.promises.readFile("/f")).rejects.toThrow();
  });

  it("readFile with no encoding returns Uint8Array", async () => {
    const fs = createOpfsFs(root as any);
    await fs.promises.writeFile("/f", new Uint8Array([1, 2, 3]));
    const out = await fs.promises.readFile("/f");
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("symlink and readlink reject", async () => {
    const fs = createOpfsFs(root as any);
    await expect(fs.promises.symlink("a", "b")).rejects.toThrow();
    await expect(fs.promises.readlink("b")).rejects.toThrow();
  });
});
