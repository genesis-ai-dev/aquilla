// One Paratext project can sit in several folders on one computer: Paratext 9,
// Paratext 10 and Paratext Lite each keep their own copy, as does a Wine
// prefix. The copies share Settings.xml's <Guid>, and Paratext's Send/Receive
// brings each one up to date, but only when that copy's own app runs it.
// Between runs the copies differ, so Aquilla treats them as ONE project with
// ONE live copy: the folder its mirror writes to. The others are shown beside
// it and never get a mirror of their own, but the mirror reads them too
// (copy-inbound.ts), so an edit made in any of the apps shows up at once.

import type { BridgeProject } from "./use-paratext-discovery"

export type CopyApp = "paratext10" | "lite" | "wine" | "paratext"

/** Which app keeps the copy in this folder, read off the folder Paratext
 *  puts it in (see `platform_default_roots` in src-tauri/src/paratext.rs). */
export function copyApp(path: string): CopyApp {
  const p = path.replace(/\\/g, "/").toLowerCase()
  if (p.includes("/.paratext-10-studio/") || p.includes("/.platform.bible/")) return "paratext10"
  if (p.includes("/paratextlite/")) return "lite"
  if (p.includes("/.wine")) return "wine"
  return "paratext"
}

export interface ProjectCopies {
  guid: string
  /** Every folder holding this project, in discovery order. */
  copies: BridgeProject[]
}

/** Group discovered folders by project GUID, keeping the order in which each
 *  GUID first appears. */
export function groupCopies(projects: readonly BridgeProject[]): ProjectCopies[] {
  const byGuid = new Map<string, ProjectCopies>()
  for (const p of projects) {
    const key = p.guid.toLowerCase()
    const group = byGuid.get(key)
    if (group) group.copies.push(p)
    else byGuid.set(key, { guid: p.guid, copies: [p] })
  }
  return [...byGuid.values()]
}

/** The other folders holding the same project as `project`. */
export function otherCopies(project: BridgeProject, projects: readonly BridgeProject[]): BridgeProject[] {
  const guid = project.guid.toLowerCase()
  return projects.filter((p) => p.guid.toLowerCase() === guid && p.stateId !== project.stateId)
}

/** The copy Aquilla's mirror uses: the linked one. None until the project is
 *  opened in Aquilla. If an older version linked more than one copy, the first
 *  linked copy in discovery order wins, so the answer is stable. */
export function liveCopy(copies: readonly BridgeProject[], linked: ReadonlySet<string>): BridgeProject | null {
  return copies.find((p) => linked.has(p.stateId)) ?? null
}
