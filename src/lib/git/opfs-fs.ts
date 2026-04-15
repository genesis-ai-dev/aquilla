// Minimal fs.promises shim over OPFS for isomorphic-git.
// Supports: readFile, writeFile, unlink, mkdir, rmdir, readdir, stat, lstat, readlink, symlink.

type DirHandle = FileSystemDirectoryHandle;
type FileHandle = FileSystemFileHandle;

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

// isomorphic-git inspects err.code as a string ('ENOENT', 'ENOTDIR', etc.).
// OPFS throws DOMException whose .code is a number — wrap it.
const DOM_TO_POSIX: Record<string, string> = {
  NotFoundError: "ENOENT",
  TypeMismatchError: "ENOTDIR",
  QuotaExceededError: "ENOSPC",
  InvalidModificationError: "EPERM",
  NoModificationAllowedError: "EPERM",
  SecurityError: "EACCES",
};

function translateError(err: unknown): never {
  if (err && typeof err === "object") {
    const e = err as { name?: string; message?: string; code?: unknown };
    const name = typeof e.name === "string" ? e.name : "";
    const posix = DOM_TO_POSIX[name] ?? (typeof e.code === "string" ? e.code : "EIO");
    const wrapped = new Error(`${posix}: ${e.message ?? name ?? "fs error"}`) as Error & {
      code: string; errno: number;
    };
    wrapped.code = posix;
    wrapped.errno = -1;
    throw wrapped;
  }
  throw err;
}

async function tx<T>(op: () => Promise<T>): Promise<T> {
  try { return await op(); }
  catch (e) { translateError(e); }
}

async function resolveDir(
  root: DirHandle,
  parts: string[],
  opts?: { create?: boolean },
): Promise<DirHandle> {
  let dir = root;
  for (const p of parts) {
    dir = await dir.getDirectoryHandle(p, { create: !!opts?.create });
  }
  return dir;
}

async function resolveParent(
  root: DirHandle,
  path: string,
  opts?: { create?: boolean },
) {
  const parts = splitPath(path);
  const name = parts.pop();
  if (!name) throw new Error(`Invalid path: ${path}`);
  const parent = await resolveDir(root, parts, opts);
  return { parent, name };
}

interface Stats {
  type: "file" | "dir";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function makeStats(
  type: "file" | "dir",
  size: number,
  mtimeMs: number,
): Stats {
  return {
    type,
    size,
    mtimeMs,
    ctimeMs: mtimeMs,
    ino: 0,
    mode: type === "file" ? 0o100644 : 0o040755,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile() {
      return type === "file";
    },
    isDirectory() {
      return type === "dir";
    },
    isSymbolicLink() {
      return false;
    },
  };
}

export interface OpfsFs {
  promises: {
    readFile(
      path: string,
      opts?: { encoding?: string },
    ): Promise<string | Uint8Array>;
    writeFile(
      path: string,
      data: string | Uint8Array | ArrayBuffer,
      opts?: { encoding?: string },
    ): Promise<void>;
    unlink(path: string): Promise<void>;
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
    rmdir(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<Stats>;
    lstat(path: string): Promise<Stats>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
  };
}

export function createOpfsFs(root: DirHandle): OpfsFs {
  async function getFileHandle(
    path: string,
    opts?: { create?: boolean },
  ): Promise<FileHandle> {
    const { parent, name } = await resolveParent(root, path, opts);
    return parent.getFileHandle(name, { create: !!opts?.create });
  }

  return {
    promises: {
      readFile: (path, opts) => tx(async () => {
        const handle = await getFileHandle(path);
        const file = await handle.getFile();
        const buf = new Uint8Array(await file.arrayBuffer());
        if (opts?.encoding === "utf8") return new TextDecoder().decode(buf);
        return buf;
      }),

      writeFile: (path, data) => tx(async () => {
        const handle = await getFileHandle(path, { create: true });
        const writable = await handle.createWritable();
        const bytes =
          typeof data === "string"
            ? new TextEncoder().encode(data)
            : data instanceof Uint8Array
              ? data
              : new Uint8Array(data);
        await writable.write(bytes as BufferSource);
        await writable.close();
      }),

      unlink: (path) => tx(async () => {
        const { parent, name } = await resolveParent(root, path);
        await parent.removeEntry(name);
      }),

      mkdir: (path, opts) => tx(async () => {
        const parts = splitPath(path);
        if (opts?.recursive) {
          await resolveDir(root, parts, { create: true });
          return;
        }
        const name = parts.pop();
        if (!name) return;
        const parent = await resolveDir(root, parts);
        await parent.getDirectoryHandle(name, { create: true });
      }),

      rmdir: (path) => tx(async () => {
        const { parent, name } = await resolveParent(root, path);
        await parent.removeEntry(name);
      }),

      readdir: (path) => tx(async () => {
        const parts = splitPath(path);
        const dir = await resolveDir(root, parts);
        const out: string[] = [];
        const keys = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
        for await (const k of keys) out.push(k);
        return out;
      }),

      stat: (path) => tx(async () => {
        const parts = splitPath(path);
        const name = parts.pop();
        if (!name) return makeStats("dir", 0, 0);
        const parent = await resolveDir(root, parts);
        try {
          const fh = await parent.getFileHandle(name);
          const f = await fh.getFile();
          return makeStats("file", f.size, f.lastModified);
        } catch {
          const dh = await parent.getDirectoryHandle(name);
          void dh;
          return makeStats("dir", 0, 0);
        }
      }),

      async lstat(path) {
        return this.stat(path);
      },

      async readlink() {
        const e = new Error("ENOTSUP: symlinks not supported on OPFS") as Error & { code: string };
        e.code = "ENOTSUP";
        throw e;
      },

      async symlink() {
        const e = new Error("ENOTSUP: symlinks not supported on OPFS") as Error & { code: string };
        e.code = "ENOTSUP";
        throw e;
      },
    },
  };
}

// Open the app's OPFS root and return a subdirectory handle for the given
// dir-name under `/repos/`, creating it if needed.
export async function openOpfsRepoDir(repoKey: string): Promise<DirHandle> {
  const root = await navigator.storage.getDirectory();
  const repos = await root.getDirectoryHandle("repos", { create: true });
  return repos.getDirectoryHandle(repoKey, { create: true });
}
