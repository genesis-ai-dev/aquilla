type QueryValue = string | number | boolean | null | undefined

function withQuery(path: string, query: Record<string, QueryValue>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

export function workspaceReturnPath(projectId: string, fileId?: string | null): string {
  const encoded = encodeURIComponent(projectId)
  const base = `/project/${encoded}/editor`
  return fileId ? `${base}/file/${encodeURIComponent(fileId)}` : base
}


export function buildProjectSettingsHandoffUrl(args: {
  projectId: string
  section?: string
  returnTo?: string
}): string {
  return withQuery(`/project/${encodeURIComponent(args.projectId)}/settings`, {
    section: args.section,
    return: args.returnTo ?? workspaceReturnPath(args.projectId),
  })
}
