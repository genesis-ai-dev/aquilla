// Minimal in-memory stand-in for FileSystemDirectoryHandle / FileSystemFileHandle.
export class MemoryFileHandle {
  kind = "file" as const;
  name: string;
  private data: Uint8Array;

  constructor(name: string, data: Uint8Array = new Uint8Array()) {
    this.name = name;
    this.data = data;
  }

  async getFile() {
    const d = this.data;
    return {
      name: this.name,
      size: d.byteLength,
      lastModified: 0,
      async arrayBuffer() {
        return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
      },
      async text() {
        return new TextDecoder().decode(d);
      },
    } as unknown as File;
  }

  async createWritable() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    let buf: Uint8Array = new Uint8Array();
    return {
      async write(chunk: Uint8Array | string) {
        const bytes =
          typeof chunk === "string"
            ? (new TextEncoder().encode(chunk) as Uint8Array)
            : chunk;
        buf = bytes;
      },
      async close() {
        self.data = buf;
      },
    };
  }
}

export class MemoryDirectoryHandle {
  kind = "directory" as const;
  name: string;
  private entries = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();

  constructor(name: string) {
    this.name = name;
  }

  async getDirectoryHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<MemoryDirectoryHandle> {
    let e = this.entries.get(name);
    if (!e) {
      if (!opts?.create) throw new DOMException("NotFound", "NotFoundError");
      e = new MemoryDirectoryHandle(name);
      this.entries.set(name, e);
    }
    if (e.kind !== "directory")
      throw new DOMException("TypeMismatch", "TypeMismatchError");
    return e;
  }

  async getFileHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<MemoryFileHandle> {
    let e = this.entries.get(name);
    if (!e) {
      if (!opts?.create) throw new DOMException("NotFound", "NotFoundError");
      e = new MemoryFileHandle(name);
      this.entries.set(name, e);
    }
    if (e.kind !== "file")
      throw new DOMException("TypeMismatch", "TypeMismatchError");
    return e;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.entries.delete(name))
      throw new DOMException("NotFound", "NotFoundError");
  }

  async *keys() {
    for (const k of this.entries.keys()) yield k;
  }
  async *values() {
    for (const v of this.entries.values()) yield v;
  }
  async *entries_() {
    for (const e of this.entries.entries()) yield e;
  }
  [Symbol.asyncIterator]() {
    return this.entries_();
  }
}
