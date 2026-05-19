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
  const projectPath = `/w/${encodeURIComponent(projectId)}`
  return fileId ? `${projectPath}/file/${encodeURIComponent(fileId)}` : `${projectPath}/`
}

export function buildImportHandoffUrl(args: {
  projectId: string
  fileId?: string | null
  returnTo?: string
}): string {
  return withQuery("/import/", {
    project: args.projectId,
    file: args.fileId,
    return: args.returnTo ?? workspaceReturnPath(args.projectId, args.fileId),
  })
}

export function buildExportHandoffUrl(args: {
  projectId: string
  fileId?: string | null
  returnTo?: string
}): string {
  return withQuery("/export/", {
    project: args.projectId,
    file: args.fileId,
    return: args.returnTo ?? workspaceReturnPath(args.projectId, args.fileId),
  })
}

export function buildProjectSettingsHandoffUrl(args: {
  projectId: string
  section?: string
  returnTo?: string
}): string {
  return withQuery(`/projects/${encodeURIComponent(args.projectId)}/settings`, {
    section: args.section,
    return: args.returnTo ?? workspaceReturnPath(args.projectId),
  })
}
