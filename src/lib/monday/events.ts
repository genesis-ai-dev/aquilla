/** Keep mounted overview shortcuts current when settings changes a link. */
const LINK_CHANGED = "aquilla:monday-link-changed"

export function notifyMondayLinkChanged(projectId: string): void {
  window.dispatchEvent(new CustomEvent<string>(LINK_CHANGED, { detail: projectId }))
}

export function onMondayLinkChanged(projectId: string, refresh: () => void): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<string>).detail === projectId) refresh()
  }
  window.addEventListener(LINK_CHANGED, listener)
  return () => window.removeEventListener(LINK_CHANGED, listener)
}
