import { invoke } from "@tauri-apps/api/core";
import type { FsProvider, FsProviderOptions } from "./types";

interface RawStat { kind: "file" | "dir"; size: number; mtime_ms: number }

function makeStats(raw: RawStat) {
  return {
    type: raw.kind,
    size: raw.size,
    mtimeMs: raw.mtime_ms,
    ctimeMs: raw.mtime_ms,
    ino: 0,
    mode: raw.kind === "file" ? 0o100644 : 0o040755,
    uid: 1, gid: 1, dev: 1,
    isFile: () => raw.kind === "file",
    isDirectory: () => raw.kind === "dir",
    isSymbolicLink: () => false,
  };
}

function rethrow(e: unknown): never {
  const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  const m = msg.match(/^([A-Z]+):/);
  const code = m ? m[1] : "EIO";
  const err = new Error(msg) as Error & { code: string; errno: number };
  err.code = code;
  err.errno = -1;
  throw err;
}

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(cmd, args); }
  catch (e) { rethrow(e); }
}

export async function createTauriFsProvider(
  repoKey: string,
  opts: FsProviderOptions = {},
): Promise<FsProvider> {
  if (opts.reset) await call<void>("fs_reset_repo", { repoKey });

  return {
    promises: {
      async readFile(path, o) {
        const bytes = await call<number[]>("fs_read_file", { repoKey, path });
        const buf = new Uint8Array(bytes);
        if (o?.encoding === "utf8") return new TextDecoder().decode(buf);
        return buf;
      },
      async writeFile(path, data) {
        const bytes = typeof data === "string"
          ? new TextEncoder().encode(data)
          : data instanceof Uint8Array ? data : new Uint8Array(data);
        await call<void>("fs_write_file", { repoKey, path, data: Array.from(bytes) });
      },
      async unlink(path) { await call<void>("fs_unlink", { repoKey, path }); },
      async mkdir(path, o) { await call<void>("fs_mkdir", { repoKey, path, recursive: !!o?.recursive }); },
      async rmdir(path) { await call<void>("fs_rmdir", { repoKey, path }); },
      async readdir(path) { return call<string[]>("fs_readdir", { repoKey, path }); },
      async stat(path) { return makeStats(await call<RawStat>("fs_stat", { repoKey, path })); },
      async lstat(path) { return this.stat(path); },
      async readlink() {
        const e = new Error("ENOTSUP: symlinks not supported on Tauri fs bridge") as Error & { code: string };
        e.code = "ENOTSUP";
        throw e;
      },
      async symlink() {
        const e = new Error("ENOTSUP: symlinks not supported on Tauri fs bridge") as Error & { code: string };
        e.code = "ENOTSUP";
        throw e;
      },
    },
  };
}
