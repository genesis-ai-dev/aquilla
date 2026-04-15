import type { OpfsFs } from "@/lib/git/opfs-fs";

export async function listFilesMatching(fs: OpfsFs, startDir: string, re: RegExp): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let names: string[];
    try { names = await fs.promises.readdir(dir); }
    catch { return; }
    for (const name of names) {
      const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
      try {
        const s = await fs.promises.stat(full);
        if (s.isDirectory()) await walk(full);
        else if (s.isFile() && re.test(full)) out.push(full);
      } catch { /* skip */ }
    }
  }
  await walk(startDir);
  return out;
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function joinPath(...parts: string[]): string {
  return "/" + parts.flatMap(p => p.split("/")).filter(Boolean).join("/");
}
