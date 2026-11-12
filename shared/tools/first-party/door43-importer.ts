/**
 * First-party Smart Extension (AQU-1937): the Door43 importer, rebuilt on the
 * PUBLIC importer API — an import contribution in the Import dialog, writing
 * through files.upsert, alignment through aquilla.data — and shipped like the
 * first-party editor: reviewed source in this repo, installed by the server,
 * never generated. Its script is the same Door43 code the built-in import runs
 * (see scripts/build-door43-extension.ts), so its files are the built-in's
 * files; the built-in import stays one click away in Import.
 */

import type { ToolManifest } from "../manifest"
import { DOOR43_IMPORTER_SCRIPT } from "./door43-importer.bundle"

export const FIRST_PARTY_DOOR43_IMPORTER = "door43-importer"

export const DOOR43_IMPORTER_MANIFEST: ToolManifest = {
  name: "Door43 resources",
  description:
    "Imports Door43 / unfoldingWord resources book by book as live-linked files (Bibles, OBS, notes, questions, translation words and word links), with word alignment kept as data. Refresh a file from its source any time.",
  scopes: ["read:web", "write:files", "write:data", "read:cells"],
  web: ["git.door43.org"],
  mounts: ["page"],
  apiRev: 7,
  sdk: 1,
  importers: [
    {
      id: "door43",
      label: "Door43 resources",
      description: "Bibles (ULT, UST, UGNT, UHB…), OBS, translation notes and questions, translation words and word links — book by book, live-linked.",
      options: [
        { key: "lang", label: "Language code", type: "text", default: "en", help: "The Door43 catalog language, e.g. en, es-419, fr." },
        { key: "resource", label: "Resource", type: "select", dynamic: true, dependsOn: ["lang"], required: true },
        { key: "books", label: "Books", type: "multiselect", dynamic: true, dependsOn: ["resource"], help: "None selected imports every book the resource has." },
        { key: "alignment", label: "Keep word alignment as data", type: "boolean", default: true, help: "Aligned Bibles (ULT/UST): each verse's alignment to the original is saved as extension data." },
      ],
    },
  ],
}

export const DOOR43_IMPORTER_SOURCE = `<!doctype html>
<html>
<head></head>
<body>
<p>Door43 resources: use it from Import.</p>
<script>${DOOR43_IMPORTER_SCRIPT.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>`
