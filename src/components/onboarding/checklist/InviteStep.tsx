import { useEffect, useState, useCallback } from "react"
import { Copy, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { listShares, createShare } from "@/lib/sync/share-tokens"
import type { ShareInvite } from "@/lib/parsers/types"

export function InviteStep({
  projectId,
  username,
  onSharesChanged,
}: {
  projectId: string
  username: string
  onSharesChanged: () => void
}) {
  const [shares, setShares] = useState<ShareInvite[]>([])
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    const list = await listShares(projectId)
    setShares(list)
    onSharesChanged()
  }, [projectId, onSharesChanged])

  useEffect(() => { refresh() }, [refresh])

  async function handleCreate() {
    await createShare(projectId, undefined, username)
    await refresh()
  }

  function copyUrl(token: string) {
    const url = `${window.location.origin}/join/${token}`
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (shares.length === 0) {
    return (
      <div className="space-y-2 text-center">
        <p className="text-xs text-muted-foreground">
          Share a link with translators and reviewers to collaborate in real-time.
        </p>
        <Button size="sm" variant="outline" onClick={handleCreate} className="w-full">
          <Plus className="mr-1.5 h-3 w-3" /> Create share link
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {shares.map((share) => (
        <div key={share.token} className="flex items-center gap-1">
          <input
            value={`${window.location.origin}/join/${share.token}`}
            readOnly
            className="flex-1 rounded border bg-muted/30 px-2 py-1 text-xs font-mono"
          />
          <Button size="sm" variant="ghost" onClick={() => copyUrl(share.token)} className="h-7 w-7 p-0">
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      ))}
      {copied && <p className="text-xs text-green-600">Copied!</p>}
      <Button size="sm" variant="outline" onClick={handleCreate} className="w-full">
        <Plus className="mr-1.5 h-3 w-3" /> Create another link
      </Button>
    </div>
  )
}
