export interface CorpusGroup<T = unknown> {
  label: string
  files: T[]
}

function normalize(marker: string): string {
  return marker.trim().toLowerCase()
}

export function groupByCorpus<T extends { name: string; corpusMarker?: string }>(
  files: T[],
): CorpusGroup<T>[] {
  const groupsByKey = new Map<string, { label: string; files: T[] }>()
  const ungrouped: T[] = []

  for (const file of files) {
    const raw = file.corpusMarker?.trim()
    if (!raw) {
      ungrouped.push(file)
      continue
    }
    const key = normalize(raw)
    const existing = groupsByKey.get(key)
    if (existing) {
      existing.files.push(file)
    } else {
      groupsByKey.set(key, { label: raw, files: [file] })
    }
  }

  for (const group of groupsByKey.values()) {
    group.files.sort((a, b) => a.name.localeCompare(b.name))
  }
  ungrouped.sort((a, b) => a.name.localeCompare(b.name))

  const named = Array.from(groupsByKey.values()).sort((a, b) => {
    if (a.label === "OT" && b.label !== "OT") return -1
    if (b.label === "OT" && a.label !== "OT") return 1
    if (a.label === "NT" && b.label !== "NT") return -1
    if (b.label === "NT" && a.label !== "NT") return 1
    return a.label.localeCompare(b.label)
  })

  if (ungrouped.length > 0) named.push({ label: "Ungrouped", files: ungrouped })
  return named
}
