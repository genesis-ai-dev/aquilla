import * as Y from "yjs";
import type { OpfsFs } from "@/lib/git/opfs-fs";
import {
  parseCodexNotebook, parseCodexComments, parseCodexProjectMetadata,
  pairCells, mapEditHistory, mapCodexCommentsToThreads,
} from "@/lib/codex-editor";
import type { CodexCell, CodexCommentsFile } from "@/lib/codex-editor";
import { listFilesMatching, basename } from "./opfs-paths";
import type {
  ProjectRecord, FileReference, ProjectPermissions, ProjectOrigin,
  CommentThread, FileType, TranslatableString,
} from "@/lib/parsers/types";
import { v4 as uuid } from "uuid";
import { IndexeddbPersistence } from "y-indexeddb";
import { createProject } from "@/lib/store/project-index";
import { createFileDoc } from "@/lib/store/file-doc";
import { setFragmentFromHtml } from "@/lib/richtext/translated-xml";
import type { FrontierSession, GitlabProject } from "@/lib/frontier/types";
import { cloneRepo } from "@/lib/git/clone";
import { openOpfsRepoDir, createOpfsFs } from "@/lib/git/opfs-fs";
import { mapGitlabAccessLevel, bestAccessLevel } from "@/lib/git/permissions";

const VTT_RE = /^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/;
const SCRIPTURE_RE = /^[A-Z1-3]{3} \d+:\d+/;

function inferFileType(paired: TranslatableString[]): FileType {
  for (const c of paired) {
    if (VTT_RE.test(c.context)) return "vtt";
    if (SCRIPTURE_RE.test(c.context)) return "usfm";
  }
  return "txt";
}

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

  // 3. Parse comments once, keyed by cellId. Also keep the raw file so we can
  //    stash the original thread JSON on each Y.Map via __source.
  let commentsByCell: Record<string, CommentThread[]> = {};
  let parsedComments: CodexCommentsFile | null = null;
  try {
    const raw = (await fs.promises.readFile(`${repoDir}/.project/comments.json`, { encoding: "utf8" })) as string;
    parsedComments = parseCodexComments(raw);
    commentsByCell = mapCodexCommentsToThreads(parsedComments);
  } catch { /* no comments */ }

  // 4. For each .codex, build a Y.Doc using the canonical createFileDoc shape
  //    (cells = Y.Map<id, Y.Map>, order = Y.Array<id>, etc.) so the editor
  //    can read it. Then layer history/threads/video on top.
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
    const fileType = inferFileType(paired);
    const fileId = uuid();

    // Build edit-history map keyed by source cell id.
    const historyById = new Map<string, ReturnType<typeof mapEditHistory>>();
    for (const c of nb.cells) {
      if (!c.metadata.edits?.length) continue;
      const entries = mapEditHistory(c.metadata.edits);
      if (entries.length) historyById.set(c.metadata.id, entries);
    }

    const handle = createFileDoc(fileId, stem, fileType, sourceLanguage, targetLanguage, paired);
    const { doc } = handle;

    doc.transact(() => {
      const cellsMap = doc.getMap("cells");

      // codex-editor stores cell.value as HTML (e.g. "<p><span>...</span></p>").
      // createFileDoc seeded translatedXml as plain text — re-parse as HTML so
      // the editor doesn't render literal <span> tags as text.
      for (const c of paired) {
        if (!c.translated) continue;
        const cell = cellsMap.get(c.id) as Y.Map<unknown> | undefined;
        if (!cell) continue;
        const frag = cell.get("translatedXml") as Y.XmlFragment | undefined;
        if (!frag) continue;
        setFragmentFromHtml(frag, c.translated);
      }

      // Stash the raw CodexCell source on each cell under __source so the
      // serializer can round-trip unknown fields (attachments, data, etc.).
      for (const sourceCell of nb.cells) {
        const cell = cellsMap.get(sourceCell.metadata.id) as Y.Map<unknown> | undefined;
        if (!cell) continue;
        cell.set("__source", JSON.parse(JSON.stringify(sourceCell)));
      }

      // Layer in history per cell (createFileDoc gave each cell an empty history Y.Array).
      for (const [cellId, entries] of historyById) {
        const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined;
        if (!cell) continue;
        const histArr = cell.get("history") as Y.Array<unknown> | undefined;
        if (!histArr) continue;
        histArr.push(entries as unknown as object[]);
      }

      // Layer in comment threads per cell. Schema: Y.Array<Y.Map<unknown>>.
      for (const cellId of Object.keys(commentsByCell)) {
        const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined;
        if (!cell) continue;
        const threadsArr = new Y.Array<Y.Map<unknown>>();
        for (const t of commentsByCell[cellId]) {
          const tm = new Y.Map<unknown>();
          tm.set("id", t.id);
          tm.set("status", t.status);
          tm.set("createdAt", t.createdAt);
          if (t.resolvedAt) tm.set("resolvedAt", t.resolvedAt);
          if (t.resolvedBy) tm.set("resolvedBy", t.resolvedBy);
          tm.set("createdForTranslated", t.createdForTranslated);
          tm.set("messages", t.messages);
          const originalThreadJson = parsedComments?.[t.id];
          if (originalThreadJson) {
            tm.set("__source", JSON.parse(JSON.stringify(originalThreadJson)));
          }
          threadsArr.push([tm]);
        }
        cell.set("threads", threadsArr);
      }

      // Video metadata (cue-aligned files only).
      const metaMap = doc.getMap("meta");
      if (nb.metadata.videoUrl) {
        metaMap.set("videoUrl", nb.metadata.videoUrl);
        if (nb.metadata.originalName) metaMap.set("videoFileName", nb.metadata.originalName);
      }
      // Stash the raw CodexNotebookMetadata under __source on the file meta so
      // the serializer can round-trip unknown notebook-level fields.
      metaMap.set("__source", JSON.parse(JSON.stringify(nb.metadata)));
    });

    docs[fileId] = doc;
    // We hold the Y.Doc but release the persistence so the next loop iteration
    // doesn't pile up open IDB handles. persistImportedProject reattaches.
    handle.persistence.destroy();

    files.push({
      id: fileId,
      name: stem,
      type: fileType,
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
    const persistence = new IndexeddbPersistence(`codex:file:${fileId}`, doc);
    await persistence.whenSynced;
    persistence.destroy();
  }
}

export async function importFromGitRepo(opts: {
  session: FrontierSession;
  project: GitlabProject;
  onPhase?: (phase: "clone" | "parse" | "persist", done: number, total: number, label: string) => void;
}): Promise<ImportedProject> {
  const { session, project, onPhase } = opts;
  const repoKey = `${project.id}-${project.path_with_namespace.replace(/\//g, "_")}`;
  const dirHandle = await openOpfsRepoDir(repoKey);
  const fs = createOpfsFs(dirHandle);

  onPhase?.("clone", 0, 1, project.name);
  const { headSha, branch } = await cloneRepo({
    fs,
    dir: "/",
    url: project.http_url_to_repo,
    gitlabToken: session.gitlabToken,
    onProgress: (p) => onPhase?.("clone", p.loaded ?? 0, p.total ?? 100, p.phase ?? "clone"),
  });
  onPhase?.("clone", 1, 1, "done");

  const permissions = mapGitlabAccessLevel(bestAccessLevel(project));
  const imported = await importFromOpfs({
    fs, repoDir: "/",
    origin: {
      kind: "git",
      cloneUrl: project.http_url_to_repo,
      gitlabProjectId: project.id,
      branch,
      headSha,
      importedAt: new Date().toISOString(),
    },
    permissions,
    onProgress: (done, total, label) => onPhase?.("parse", done, total, label),
  });

  onPhase?.("persist", 0, 1, "saving");
  await persistImportedProject(imported);
  onPhase?.("persist", 1, 1, "done");
  return imported;
}
