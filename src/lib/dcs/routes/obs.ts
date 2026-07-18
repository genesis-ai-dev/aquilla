// Open Bible Stories (OBS) resource route (spec §4). One story *frame* → one
// cell, id seeded `${repo}|OBS story:frame`. Reuses the existing OBS markdown
// parser (parseObsStories), then overrides its fresh uuids with deterministic
// content-addressed ids and stamps content hashes.
//
// Frame reference images ride through in `metadata.attachments` — the same
// extensible bucket the parser already populates — so downstream import keeps
// each frame's image without a schema change.

import type { DcsFile, DcsCell, ResourceRoute, DcsManifest, DcsCatalogEntry } from "../types"
import { dcsCellId, dcsFileId } from "../cell-id"
import { contentHash } from "../content-hash"
import { parseObsStories } from "@/lib/parsers/obs"

/** True for the Open Bible Stories resource. Routed by subject (never repo name)
 *  with a manifest fallback: rcType `book` + markdown OBS identifier. */
function isObs(entry: DcsCatalogEntry, manifest: DcsManifest): boolean {
  const subject = entry.subject.toLowerCase()
  if (subject.includes("open bible stories")) return true
  // Manifest fallback: an OBS RC is a `book`-type markdown resource whose
  // identifier is "obs" (e.g. en_obs). Guards against a blank/renamed subject.
  const fmt = manifest.format.toLowerCase()
  const ident = manifest.identifier.toLowerCase()
  return manifest.rcType === "book" && fmt.includes("markdown") && ident === "obs"
}

/** Only real OBS story files are `NN.md` (01.md … 50.md); front/back matter and
 *  the license live under other names and carry no frames. */
function isObsStoryFile(path: string): boolean {
  const base = path.split("/").pop() ?? path
  return /^\d+\.md$/.test(base)
}

export const obsRoute: ResourceRoute = {
  id: "obs",
  matches: (entry, manifest) => isObs(entry, manifest),
  parse: ({ entry, files }) => {
    const repo = entry.fullName
    const out: DcsFile[] = []

    // Deterministic file order so multi-story imports and their ids are stable
    // regardless of Map insertion order.
    const paths = [...files.keys()].filter(isObsStoryFile).sort()

    for (const path of paths) {
      const text = files.get(path)!
      const base = path.split("/").pop() ?? path
      // parseObsStories reads the story number from the file name (`NN.md`) so
      // the frame `group` becomes `OBS <story>:<frame>` — the id seed per §4.
      const frames = parseObsStories(text, base)
      if (frames.length === 0) continue

      const cells: DcsCell[] = frames.map((frame) => {
        // frame.group === "OBS <story>:<frame>" — the canonical OBS ref.
        const ref = frame.group
        const cell: DcsCell = {
          cellId: dcsCellId(`${repo}|${ref}`),
          value: frame.original,
          type: frame.type,
          canonicalRef: ref,
          contentHash: contentHash(frame.original),
        }
        // Carry the frame's reference image(s) through untouched.
        if (frame.metadata !== undefined) cell.metadata = frame.metadata
        return cell
      })

      out.push({
        fileId: dcsFileId(repo, path),
        name: frames[0].section ?? base,
        cells,
      })
    }

    return out
  },
}
