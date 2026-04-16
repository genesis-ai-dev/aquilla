// Shared derivation of the OPFS subdirectory name for a cloned git repo.
// Both the importer (writes) and sync (reads) must agree on this string, or
// sync opens an empty dir and isomorphic-git hits null HEAD.
export function opfsRepoKey(projectId: number, pathWithNamespace: string): string {
  return `${projectId}-${pathWithNamespace.replace(/\//g, "_")}`
}

// ProjectRecord.origin only has cloneUrl, so sync derives path_with_namespace
// from the URL. For "https://host/group/sub/repo.git" this yields "group/sub/repo".
export function pathWithNamespaceFromCloneUrl(cloneUrl: string): string {
  return new URL(cloneUrl).pathname.replace(/^\//, "").replace(/\.git$/, "")
}
