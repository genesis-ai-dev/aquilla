// Minimal fs.promises shim over OPFS for isomorphic-git.
// Supports: readFile, writeFile, unlink, mkdir, rmdir, readdir, stat, lstat, readlink, symlink.

type DirHandle = FileSystemDirectoryHandle;
type FileHandle = FileSystemFileHandle;

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
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
      async readFile(path, opts) {
        const handle = await getFileHandle(path);
        const file = await handle.getFile();
        const buf = new Uint8Array(await file.arrayBuffer());
        if (opts?.encoding === "utf8") return new TextDecoder().decode(buf);
        return buf;
      },

      async writeFile(path, data) {
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
      },

      async unlink(path) {
        const { parent, name } = await resolveParent(root, path);
        await parent.removeEntry(name);
      },

      async mkdir(path, opts) {
        const parts = splitPath(path);
        if (opts?.recursive) {
          await resolveDir(root, parts, { create: true });
          return;
        }
        const name = parts.pop();
        if (!name) return;
        const parent = await resolveDir(root, parts);
        await parent.getDirectoryHandle(name, { create: true });
      },

      async rmdir(path) {
        const { parent, name } = await resolveParent(root, path);
        await parent.removeEntry(name);
      },

      async readdir(path) {
        const parts = splitPath(path);
        const dir = await resolveDir(root, parts);
        const out: string[] = [];
        const keys = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
        for await (const k of keys) out.push(k);
        return out;
      },

      async stat(path) {
        const parts = splitPath(path);
        const name = parts.pop();
        if (!name) return makeStats("dir", 0, 0);
        const parent = await resolveDir(root, parts);
        try {
          const fh = await parent.getFileHandle(name);
          const f = await fh.getFile();
          return makeStats("file", f.size, f.lastModified);
        } catch {
          await parent.getDirectoryHandle(name);
          return makeStats("dir", 0, 0);
        }
      },

      async lstat(path) {
        return this.stat(path);
      },

      async readlink() {
        throw new Error("ENOTSUP: symlinks not supported on OPFS");
      },

      async symlink() {
        throw new Error("ENOTSUP: symlinks not supported on OPFS");
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
