import { useState } from "react"
import { Copy, Plus, UserPlus, Check, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createServerInvite } from "@/lib/sync/invites"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { ROLE } from "@/lib/frontier/roles"

interface InviteStepProps {
  projectId: string
  onSharesChanged: () => void
}

/**
 * Onboarding-flavoured invite UI. Two paths, both produce real project
 * membership server-side:
 *
 *   1. By username: you know the collaborator's Frontier handle → server
 *      adds them to project_members directly.
 *   2. Share link: you don't know the handle (yet) → we mint a server-backed
 *      invite token; the joiner accepts it on /join/:token, which adds them
 *      as a contributor.
 *
 * Sign-in is required for both paths — server membership is the gate that
 * unlocks /sync-token, so there's no "local-only" fallback that would
 * actually work for the joiner.
 */
export function InviteStep({ projectId, onSharesChanged }: InviteStepProps) {
  const { session } = useFrontierSession()
  const { add, error: memberError } = useProjectMembers(projectId)

  const [inviteUsername, setInviteUsername] = useState("")
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteResult, setInviteResult] = useState<
    { kind: "ok"; username: string } | { kind: "error"; message: string } | null
  >(null)

  const [linkBusy, setLinkBusy] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

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
      const member = await add(trimmed, ROLE.CONTRIBUTOR)
      if (!member) {
        setInviteResult({
          kind: "error",
          message: `No Aquilla user named "${trimmed}".`,
        })
      } else {
        setInviteResult({ kind: "ok", username: member.username })
        setInviteUsername("")
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
    setLinkError(null)
    if (!session?.jwt) {
      setLinkError("Sign in to create an invite link.")
      return
    }
    setLinkBusy(true)
    try {
      const serverInvite = await createServerInvite(session.jwt, projectId, ROLE.CONTRIBUTOR)
      if (!serverInvite) {
        setLinkError("Couldn't create invite. Try again, or check your permission on this project.")
        return
      }
      setIssuedUrl(`${window.location.origin}/join/${serverInvite.token}`)
      onSharesChanged()
    } finally {
      setLinkBusy(false)
    }
  }

  function copyUrl(url: string) {
    void navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
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
          Invite by Aquilla username
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
          {!issuedUrl && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleCreateLink}
              disabled={linkBusy || !session?.jwt}
              className="h-7"
            >
              <Plus className="mr-1 h-3 w-3" />
              {linkBusy ? "Creating…" : "Create link"}
            </Button>
          )}
        </div>
        {issuedUrl ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <Input value={issuedUrl} readOnly className="h-7 text-[11px] font-mono" />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => copyUrl(issuedUrl)}
                className="h-7 w-7 p-0"
                title={copied ? "Copied!" : "Copy"}
              >
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-600" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => { setIssuedUrl(null); setCopied(false) }}
              className="h-7 w-full text-xs"
            >
              <Plus className="mr-1 h-3 w-3" />
              Create another link
            </Button>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Anyone with the link joins as a contributor after signing in. Use
            this when you don't have the recipient's username yet.
          </p>
        )}
        {linkError && (
          <p className="flex items-start gap-1 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{linkError}</span>
          </p>
        )}
      </div>
    </div>
  )
}
