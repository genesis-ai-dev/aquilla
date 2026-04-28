import { useEffect, useState, useCallback } from "react"
import { Copy, Plus, UserPlus, Check, AlertCircle, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { listShares, createShare, deleteShare } from "@/lib/sync/share-tokens"
import { createServerInvite } from "@/lib/sync/invites"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import type { ShareInvite } from "@/lib/parsers/types"

const CONTRIBUTOR_ROLE = 400

interface InviteStepProps {
  projectId: string
  username: string
  onSharesChanged: () => void
}

/**
 * Onboarding-flavoured invite UI. Two paths, both produce real project
 * membership server-side:
 *
 *   1. By username: you know the collaborator's Frontier handle → server
 *      adds them to project_members directly.
 *   2. Share link: you don't know the handle (yet) → we mint a server-backed
 *      invite token; the joiner accepts it, which adds them as a contributor.
 *
 * The previous version only created a local share doc, which gave the joiner
 * a live session but never enrolled them as a member. This step now relies
 * on the same server endpoints SharePanel uses.
 */
export function InviteStep({ projectId, username, onSharesChanged }: InviteStepProps) {
  const { session } = useFrontierSession()
  const { add, error: memberError } = useProjectMembers(projectId)

  const [inviteUsername, setInviteUsername] = useState("")
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteResult, setInviteResult] = useState<
    { kind: "ok"; username: string } | { kind: "error"; message: string } | null
  >(null)

  const [shares, setShares] = useState<ShareInvite[]>([])
  const [linkBusy, setLinkBusy] = useState(false)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const list = await listShares(projectId)
    setShares(list)
    onSharesChanged()
  }, [projectId, onSharesChanged])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault()
    if (!session?.jwt) {
      setInviteResult({
        kind: "error",
        message: "Sign in to invite by username.",
      })
      return
    }
    const trimmed = inviteUsername.trim()
    if (!trimmed) return
    setInviteBusy(true)
    setInviteResult(null)
    try {
      const member = await add(trimmed, CONTRIBUTOR_ROLE)
      if (!member) {
        setInviteResult({
          kind: "error",
          message: `No Frontier user named "${trimmed}".`,
        })
      } else {
        setInviteResult({ kind: "ok", username: member.username })
        setInviteUsername("")
        // listShares isn't affected, but onSharesChanged surfaces the new
        // member to the parent's checklist count via project members refresh.
        onSharesChanged()
      }
    } catch (err) {
      setInviteResult({
        kind: "error",
        message: err instanceof Error ? err.message : "Couldn't add member.",
      })
    } finally {
      setInviteBusy(false)
    }
  }

  async function handleCreateLink() {
    setLinkBusy(true)
    try {
      // Server-side first so token + membership grant agree. Falls back to
      // local-only when offline; the joiner won't gain server-side access in
      // that case, but the share doc is still useful for live sessions.
      const serverInvite = session?.jwt
        ? await createServerInvite(session.jwt, projectId, CONTRIBUTOR_ROLE)
        : null
      await createShare(projectId, undefined, username, serverInvite?.token)
      await refresh()
    } finally {
      setLinkBusy(false)
    }
  }

  async function handleDeleteLink(token: string) {
    await deleteShare(token)
    await refresh()
  }

  function copyUrl(token: string) {
    const url = `${window.location.origin}/join/${token}`
    void navigator.clipboard.writeText(url)
    setCopiedToken(token)
    setTimeout(() => setCopiedToken((t) => (t === token ? null : t)), 1500)
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Add teammates as <strong>contributors</strong> — they can read, comment,
        and edit cells. You can change roles or upgrade them in Project →
        Share.
      </p>

      {/* Direct username invite */}
      <form onSubmit={handleAddMember} className="space-y-2">
        <Label htmlFor="invite-user" className="text-xs">
          Invite by Frontier username
        </Label>
        <div className="flex gap-1.5">
          <Input
            id="invite-user"
            value={inviteUsername}
            onChange={(e) => setInviteUsername(e.target.value)}
            placeholder="e.g. mariad"
            className="text-sm"
            disabled={inviteBusy || !session?.jwt}
          />
          <Button
            type="submit"
            size="sm"
            disabled={inviteBusy || !inviteUsername.trim() || !session?.jwt}
          >
            <UserPlus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </div>
        {!session?.jwt && (
          <p className="text-[11px] text-muted-foreground">
            Sign in to invite by username.
          </p>
        )}
        {inviteResult?.kind === "ok" && (
          <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <Check className="h-3 w-3" /> Added <strong>{inviteResult.username}</strong>{" "}
            as contributor.
          </p>
        )}
        {inviteResult?.kind === "error" && (
          <p className="flex items-start gap-1 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{inviteResult.message}</span>
          </p>
        )}
        {memberError && !inviteResult && (
          <p className="text-xs text-destructive">{memberError}</p>
        )}
      </form>

      {/* Share-link path */}
      <div className="space-y-2 rounded-md border bg-muted/20 p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">Or share a link</span>
          {shares.length === 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleCreateLink}
              disabled={linkBusy}
              className="h-7"
            >
              <Plus className="mr-1 h-3 w-3" />
              {linkBusy ? "Creating…" : "Create link"}
            </Button>
          )}
        </div>
        {shares.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Anyone with the link joins as a contributor. Use this when you don't
            have the recipient's username yet.
          </p>
        ) : (
          <div className="space-y-1.5">
            {shares.map((share) => {
              const url = `${window.location.origin}/join/${share.token}`
              const wasCopied = copiedToken === share.token
              return (
                <div key={share.token} className="flex items-center gap-1">
                  <Input value={url} readOnly className="h-7 text-[11px] font-mono" />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => copyUrl(share.token)}
                    className="h-7 w-7 p-0"
                    title={wasCopied ? "Copied!" : "Copy"}
                  >
                    {wasCopied ? (
                      <Check className="h-3 w-3 text-emerald-600" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDeleteLink(share.token)}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    title="Revoke link"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              )
            })}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleCreateLink}
              disabled={linkBusy}
              className="h-7 w-full text-xs"
            >
              <Plus className="mr-1 h-3 w-3" />
              {linkBusy ? "Creating…" : "Create another link"}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
