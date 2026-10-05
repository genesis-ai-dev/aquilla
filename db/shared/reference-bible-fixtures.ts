// AQU-1573: TEST-ONLY. Install the committed sample chapters of Van Dyck and
// the KJV (src/lib/reference-bible/__fixtures__/, a few real chapters each:
// ISA 40, PSA 23 and 51, JHN 3, ROM 8, 1CO 13) under their real
// manifest ids and names, so worker tests exercise the same rows a loaded
// server holds without reading the 3 MB of full text or the network.
//
// Imported only by tests (node:fs); no worker entry point reaches it.

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { extractUsfmVerses } from "../../src/lib/reference-bible/usfm-verses"
import type { AquillaDb } from "../shim/postgres"
import { loadReferenceBibleVersion, type ReferenceBibleManifestEntry } from "./reference-bible-load"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const FIXTURE_FILES: Record<string, string> = {
  "arb-vandyck": "arb-vd-sample.usfm",
  "eng-kjv": "eng-kjv-sample.usfm",
}

export const FIXTURE_BIBLE_IDS = Object.keys(FIXTURE_FILES)

/** Load the sample chapters of the named Bibles (default: both). */
export async function installFixtureReferenceBibles(
  db: AquillaDb,
  ids: readonly string[] = FIXTURE_BIBLE_IDS,
): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "db/reference-bibles/manifest.json"), "utf8"),
  ) as ReferenceBibleManifestEntry[]
  for (const id of ids) {
    const file = FIXTURE_FILES[id]
    const meta = manifest.find((v) => v.id === id)
    if (!file || !meta) throw new Error(`no reference Bible fixture for "${id}"`)
    const verses = extractUsfmVerses(
      readFileSync(path.join(ROOT, "src/lib/reference-bible/__fixtures__", file), "utf8"),
    )
    // A fixture-specific hash, so a test that later loads the real text (or
    // another fixture) is never mistaken for "already loaded".
    await loadReferenceBibleVersion(
      db,
      { ...meta, verseCount: verses.length, contentSha256: `fixture-${id}-${verses.length}` },
      verses,
    )
  }
}
