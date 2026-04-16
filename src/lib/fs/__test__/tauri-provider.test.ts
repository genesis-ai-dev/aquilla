import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { createTauriFsProvider } from "../tauri-provider";

beforeEach(() => invokeMock.mockReset());

describe("tauri provider", () => {
  it("readFile decodes utf8 when requested", async () => {
    invokeMock.mockResolvedValueOnce([104, 105]); // "hi"
    const fs = await createTauriFsProvider("repo", {});
    const out = await fs.promises.readFile("/a.txt", { encoding: "utf8" });
    expect(out).toBe("hi");
    expect(invokeMock).toHaveBeenCalledWith("fs_read_file", { repoKey: "repo", path: "/a.txt" });
  });

  it("writeFile encodes string to bytes", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const fs = await createTauriFsProvider("repo", {});
    await fs.promises.writeFile("/a.txt", "hi");
    expect(invokeMock).toHaveBeenCalledWith("fs_write_file", {
      repoKey: "repo", path: "/a.txt", data: [104, 105],
    });
  });

  it("readdir returns the array unchanged", async () => {
    invokeMock.mockResolvedValueOnce(["a", "b"]);
    const fs = await createTauriFsProvider("repo", {});
    expect(await fs.promises.readdir("/")).toEqual(["a", "b"]);
  });

  it("stat maps kind/size/mtimeMs to the OpfsFs Stats shape", async () => {
    invokeMock.mockResolvedValueOnce({ kind: "file", size: 7, mtime_ms: 1234 });
    const fs = await createTauriFsProvider("repo", {});
    const s = await fs.promises.stat("/a.txt");
    expect(s.isFile()).toBe(true);
    expect(s.isDirectory()).toBe(false);
    expect(s.size).toBe(7);
    expect(s.mtimeMs).toBe(1234);
  });

  it("translates 'ENOENT: ...' errors into err.code", async () => {
    invokeMock.mockRejectedValueOnce("ENOENT: no such file");
    const fs = await createTauriFsProvider("repo", {});
    await expect(fs.promises.readFile("/missing")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reset:true calls fs_reset_repo before returning", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // fs_reset_repo
    await createTauriFsProvider("repo", { reset: true });
    expect(invokeMock).toHaveBeenCalledWith("fs_reset_repo", { repoKey: "repo" });
  });
});
