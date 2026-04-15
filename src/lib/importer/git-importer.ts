import * as Y from "yjs";
import type { OpfsFs } from "@/lib/git/opfs-fs";
import {
  parseCodexNotebook, parseCodexComments, parseCodexProjectMetadata,
  pairCells, mapEditHistory, mapCodexCommentsToThreads,
} from "@/lib/codex-editor";
import type { CodexCell } from "@/lib/codex-editor";
import { listFilesMatching, basename } from "./opfs-paths";
import type {
  ProjectRecord, FileReference, ProjectPermissions, ProjectOrigin,
  CommentThread,
} from "@/lib/parsers/types";
import { v4 as uuid } from "uuid";
import { IndexeddbPersistence } from "y-indexeddb";
import { createProject } from "@/lib/store/project-index";

export interface ImportedProject {
  project: ProjectRecord;
  docs: Record<string, Y.Doc>; // keyed by FileReference.id
}

export interface ImportArgs {
  fs: OpfsFs;
  repoDir: string;
  origin: ProjectOrigin;
  permissions: ProjectPermissions;
  onProgress?: (done: number, total: number, label: string) => void;
}

export async function importFromOpfs(args: ImportArgs): Promise<ImportedProject> {
  const { fs, repoDir, onProgress } = args;

  // 1. Parse root metadata.json (best-effort).
  let projectName = "Imported project";
  let sourceLanguage = "en";
  let targetLanguage = "en";
  try {
    const metaRaw = (await fs.promises.readFile(`${repoDir}/metadata.json`, { encoding: "utf8" })) as string;
    const meta = parseCodexProjectMetadata(metaRaw);
    if (typeof meta.projectName === "string") projectName = meta.projectName;
    if (meta.sourceLanguage?.tag) sourceLanguage = meta.sourceLanguage.tag;
    if (meta.targetLanguage?.tag) targetLanguage = meta.targetLanguage.tag;
  } catch { /* keep defaults */ }

  // 2. Enumerate .codex target files.
  const codexPaths = await listFilesMatching(fs, `${repoDir}/files/target`, /\.codex$/);
  const sourcePaths = await listFilesMatching(fs, `${repoDir}/.project/sourceTexts`, /\.source$/);

  // Index source notebooks by base name (without extension) for fallback pairing.
  const sourceByStem = new Map<string, CodexCell[]>();
  for (const p of sourcePaths) {
    try {
      const raw = (await fs.promises.readFile(p, { encoding: "utf8" })) as string;
      const nb = parseCodexNotebook(raw);
      const stem = basename(p).replace(/\.source$/, "");
      sourceByStem.set(stem, nb.cells);
    } catch { /* skip */ }
  }

  // 3. Parse comments once, keyed by cellId.
  let commentsByCell: Record<string, CommentThread[]> = {};
  try {
    const raw = (await fs.promises.readFile(`${repoDir}/.project/comments.json`, { encoding: "utf8" })) as string;
    commentsByCell = mapCodexCommentsToThreads(parseCodexComments(raw));
  } catch { /* no comments */ }

  // 4. For each .codex, build a Y.Doc.
  const files: FileReference[] = [];
  const docs: Record<string, Y.Doc> = {};
  const total = codexPaths.length;
  for (let i = 0; i < codexPaths.length; i++) {
    const p = codexPaths[i];
    const stem = basename(p).replace(/\.codex$/, "");
    onProgress?.(i, total, stem);

    let nb: ReturnType<typeof parseCodexNotebook>;
    try {
      const raw = (await fs.promises.readFile(p, { encoding: "utf8" })) as string;
      nb = parseCodexNotebook(raw);
    } catch { continue; }

    const sourceCells = sourceByStem.get(stem) ?? [];
    const paired = pairCells(sourceCells, nb.cells, stem);

    const fileId = uuid();
    const doc = new Y.Doc();
    doc.transact(() => {
      const cellsArr = doc.getArray("cells");
      cellsArr.push(paired as unknown as object[]);

      const historyMap = doc.getMap<Y.Array<unknown>>("history");
      for (const c of nb.cells) {
        if (!c.metadata.edits?.length) continue;
        const entries = mapEditHistory(c.metadata.edits);
        if (!entries.length) continue;
        const arr = new Y.Array();
        arr.push(entries as unknown as object[]);
        historyMap.set(c.metadata.id, arr);
      }

      const commentsMap = doc.getMap<Y.Array<unknown>>("comments");
      for (const c of paired) {
        const threads = commentsByCell[c.id];
        if (!threads?.length) continue;
        const arr = new Y.Array();
        arr.push(threads as unknown as object[]);
        commentsMap.set(c.id, arr);
      }

      const metaMap = doc.getMap("meta");
      if (nb.metadata.videoUrl) {
        metaMap.set("videoUrl", nb.metadata.videoUrl);
        if (nb.metadata.originalName) metaMap.set("videoFileName", nb.metadata.originalName);
      }
    });

    docs[fileId] = doc;
    files.push({
      id: fileId,
      name: stem,
      type: "txt", // TODO M13.2 — infer from content when USFM/subtitle signals available
      createdAt: new Date().toISOString(),
      cellCount: paired.length,
    });
  }
  onProgress?.(total, total, "done");

  const project: ProjectRecord = {
    id: uuid(),
    name: projectName,
    sourceLanguage,
    targetLanguage,
    createdAt: new Date().toISOString(),
    files,
    members: [],
    origin: args.origin,
    permissions: args.permissions,
  };

  return { project, docs };
}

export async function persistImportedProject(imported: ImportedProject): Promise<void> {
  await createProject(imported.project);
  for (const [fileId, doc] of Object.entries(imported.docs)) {
    const persistence = new IndexeddbPersistence(`file-${fileId}`, doc);
    await persistence.whenSynced;
    persistence.destroy();
  }
}
