import { useCallback, useEffect, useRef, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Section } from "@/components/ui/page"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { TableEmptyState } from "@/components/ui/empty"
import { toast } from "@/components/ui/toast"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import type { AdminOrg, AdminProject, AdminUser } from "@/lib/frontier/admin"
import {
  getOrgInvites,
  revokeOrgInvite,
  createAccessLink,
  createMultiProjectInvite,
  type OrgInvite,
  type CreateAccessLinkResponse,
} from "@/lib/frontier/invites"
import { isElevationRequiredError } from "@/lib/frontier/elevation"
import { useT } from "@/lib/i18n/I18nProvider"
import { ADMIN_TABLE_CLASS } from "@/components/admin/shared"
import { AdminSectionSkeleton } from "./shared"

/**
 * Invites & links — admin UI for platform-level invite and access-link management.
 * Three sections: org invites (list + revoke), access links (mint + revoke), and
 * multi-project invite. All routes require elevation (step-up gate).
 */
export function AdminInvitesSection({
  jwt,
  orgs,
  projects,
  users,
  initialOrgId,
}: {
  jwt: string
  orgs: AdminOrg[]
  projects: AdminProject[]
  users: AdminUser[]
  initialOrgId?: number
}) {
  const [selectedOrgId, setSelectedOrgId] = useState<number | null>(
    initialOrgId ?? (orgs.length > 0 ? orgs[0]?.id : null),
  )

  return (
    <div className="space-y-6">
      <OrgInvitesSection jwt={jwt} orgs={orgs} selectedOrgId={selectedOrgId} onSelectOrg={setSelectedOrgId} />
      <AccessLinksSection jwt={jwt} projects={projects} users={users} />
      <MultiProjectInviteSection jwt={jwt} projects={projects} />
    </div>
  )
}

function OrgInvitesSection({
  jwt,
  orgs,
  selectedOrgId,
  onSelectOrg,
}: {
  jwt: string
  orgs: AdminOrg[]
  selectedOrgId: number | null
  onSelectOrg: (id: number) => void
}) {
  const [invites, setInvites] = useState<OrgInvite[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!selectedOrgId) return

    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null)
    setLoading(true)
    setInvites(null)

    getOrgInvites(jwt, selectedOrgId)
      .then((data) => {
        if (!cancelled && aliveRef.current) setInvites(data)
      })
      .catch((err: unknown) => {
        if (!cancelled && aliveRef.current && !isElevationRequiredError(err)) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled && aliveRef.current) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [jwt, selectedOrgId])

  const handleRevoke = useCallback(
    async (token: string) => {
      if (!selectedOrgId) return
      setRevoking(token)
      try {
        await revokeOrgInvite(jwt, selectedOrgId, token)
        if (aliveRef.current) {
          setInvites((prev) => prev?.filter((i) => i.token !== token) ?? null)
          toast.add({ type: "success", title: "Invite revoked" })
        }
      } catch (err) {
        // Step-up needed: the global prompt is already open, so no error toast.
        if (aliveRef.current && !isElevationRequiredError(err)) {
          toast.add({
            type: "error",
            title: "Failed to revoke invite",
            description: err instanceof Error ? err.message : String(err),
          })
        }
      } finally {
        if (aliveRef.current) setRevoking(null)
      }
    },
    [jwt, selectedOrgId],
  )

  const columns: ColumnDef<OrgInvite>[] = [
    {
      id: "email",
      accessorFn: (i) => (i.email ?? "").toLowerCase(),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
      cell: ({ row }) => (
        <span className="text-sm">{row.original.email || <span className="text-muted-foreground">—</span>}</span>
      ),
    },
    {
      id: "role",
      accessorFn: (i) => i.role.name,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
      cell: ({ row }) => <span className="text-sm">{row.original.role.name}</span>,
    },
    {
      id: "created",
      accessorFn: (i) => Date.parse(i.createdAt),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
      cell: ({ row }) => (
        <DateTooltip value={row.original.createdAt} label="Created" />
      ),
    },
    {
      id: "expires",
      accessorFn: (i) => (i.expiresAt ? Date.parse(i.expiresAt) : 9999999999999),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Expires" />,
      cell: ({ row }) => (
        <DateTooltip value={row.original.expiresAt} label="Expires" />
      ),
    },
    {
      id: "actions",
      enableSorting: false,
      header: () => null,
      cell: ({ row }) => (
        <button
          type="button"
          className="text-xs text-primary hover:underline"
          onClick={() => handleRevoke(row.original.token)}
          disabled={revoking === row.original.token}
        >
          {revoking === row.original.token ? "Revoking..." : "Revoke"}
        </button>
      ),
    },
  ]

  if (!selectedOrgId) {
    return (
      <Section title="Org invites" description="Pending invites for one org.">
        <p className="text-sm text-muted-foreground">Select an organization from the dropdown.</p>
      </Section>
    )
  }

  if (loading && invites === null) {
    return <AdminSectionSkeleton label="Loading invites" blocks={1} />
  }

  return (
    <Section
      title="Org invites"
      description="Pending invites for one org."
      action={
        <div className="flex items-center gap-2">
          <Select value={String(selectedOrgId)} onValueChange={(v) => onSelectOrg(Number(v))}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {orgs.map((org) => (
                <SelectItem key={org.id} value={String(org.id)}>
                  {org.name || `#${org.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      {error ? <p className="text-sm text-destructive mb-4">{error}</p> : null}
      <DataTable
        columns={columns}
        data={invites ?? []}
        getRowId={(i) => i.token}
        initialSorting={[{ id: "created", desc: true }]}
        emptyState={
          invites && invites.length === 0 ? (
            <TableEmptyState
              icon={Mail}
              title="No pending invites"
              description="Invites appear here when created."
            />
          ) : undefined
        }
        className={ADMIN_TABLE_CLASS}
        dense
      />
    </Section>
  )
}

function AccessLinksSection({
  jwt,
  projects,
  users,
}: {
  jwt: string
  projects: AdminProject[]
  users: AdminUser[]
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [minting, setMinting] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [pin, setPin] = useState("")
  const [mintedLink, setMintedLink] = useState<CreateAccessLinkResponse | null>(null)
  const [userSearch, setUserSearch] = useState("")
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const isValidPin = /^\d{4,12}$/.test(pin)
  const canMint = selectedProjectId && selectedUserId && isValidPin

  const filteredUsers = users.filter(
    (u) =>
      u.username.toLowerCase().includes(userSearch.toLowerCase()) ||
      u.email.toLowerCase().includes(userSearch.toLowerCase()),
  )

  const handleMint = useCallback(async () => {
    if (!canMint || !selectedUserId) return
    setMinting(true)
    try {
      const result = await createAccessLink(jwt, {
        projectId: selectedProjectId,
        userId: selectedUserId,
        pin,
      })
      if (aliveRef.current) {
        setMintedLink(result)
      }
    } catch (err) {
      // Step-up needed: the global prompt is already open, so no error toast.
      if (aliveRef.current && !isElevationRequiredError(err)) {
        toast.add({
          type: "error",
          title: "Failed to create access link",
          description: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      if (aliveRef.current) setMinting(false)
    }
  }, [jwt, selectedProjectId, selectedUserId, pin, canMint])

  const handleCopyLink = useCallback(() => {
    if (mintedLink) {
      void navigator.clipboard.writeText(mintedLink.token).then(() => {
        toast.add({ type: "success", title: "Link copied to clipboard" })
      })
    }
  }, [mintedLink])

  const handleCopyPin = useCallback(() => {
    if (mintedLink) {
      void navigator.clipboard.writeText(pin).then(() => {
        toast.add({ type: "success", title: "PIN copied to clipboard" })
      })
    }
  }, [mintedLink, pin])

  const handleClose = () => {
    setMintedLink(null)
    setSelectedProjectId("")
    setSelectedUserId(null)
    setPin("")
    setUserSearch("")
    setIsOpen(false)
  }

  return (
    <Section
      title="Access links"
      description="Direct project access via token and PIN."
      action={<Button onClick={() => setIsOpen(true)}>Create access link</Button>}
    >
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{mintedLink ? "Link created" : "Create access link"}</DialogTitle>
          {mintedLink ? (
            <div className="space-y-4">
              <div>
                <Label className="text-xs font-medium text-muted-foreground">Link token</Label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="flex-1 text-xs bg-muted p-2 rounded truncate font-mono">{mintedLink.token}</code>
                  <Button size="sm" variant="outline" onClick={handleCopyLink}>
                    Copy
                  </Button>
                </div>
              </div>
              <div>
                <Label className="text-xs font-medium text-muted-foreground">PIN (shown once)</Label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="flex-1 text-xs bg-muted p-2 rounded font-mono">{pin}</code>
                  <Button size="sm" variant="outline" onClick={handleCopyPin}>
                    Copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">This PIN is not shown again.</p>
              </div>
              <Button onClick={handleClose} className="w-full">
                Done
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <Label htmlFor="project" className="text-sm">
                  Project
                </Label>
                <Select value={selectedProjectId} onValueChange={(v) => setSelectedProjectId(v || "")}>
                  <SelectTrigger id="project">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="user-search" className="text-sm">
                  User
                </Label>
                <Input
                  id="user-search"
                  placeholder="Search by name or email"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  className="mb-2"
                />
                <div className="border rounded-lg max-h-48 overflow-y-auto space-y-1 p-2">
                  {filteredUsers.length > 0 ? (
                    filteredUsers.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        className={`w-full text-left px-2 py-1 rounded text-sm hover:bg-muted ${
                          selectedUserId === u.id ? "bg-muted" : ""
                        }`}
                        onClick={() => setSelectedUserId(u.id)}
                      >
                        <div className="font-medium">{u.displayName || u.username}</div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      </button>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground p-2">No users found</p>
                  )}
                </div>
              </div>

              <div>
                <Label htmlFor="pin" className="text-sm">
                  PIN (4–12 digits, required)
                </Label>
                <Input
                  id="pin"
                  type="text"
                  placeholder="0000"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  maxLength={12}
                />
                {pin && !isValidPin && (
                  <p className="text-xs text-destructive mt-1">PIN must be 4–12 digits</p>
                )}
              </div>

              <Button onClick={handleMint} disabled={!canMint || minting} className="w-full">
                {minting ? "Creating..." : "Create link"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Section>
  )
}

function MultiProjectInviteSection({ jwt, projects }: { jwt: string; projects: AdminProject[] }) {
  const t = useT()
  const [isOpen, setIsOpen] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])
  const [everyCurrentLane, setEveryCurrentLane] = useState(false)
  const [projectSearch, setProjectSearch] = useState("")
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(projectSearch.toLowerCase()),
  )

  const toggleProject = (projectId: string) => {
    setSelectedProjectIds((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId],
    )
  }

  const handleInvite = useCallback(async () => {
    if (selectedProjectIds.length === 0 || !everyCurrentLane) return
    setInviting(true)
    try {
      const result = await createMultiProjectInvite(jwt, {
        projectIds: selectedProjectIds,
        allCurrentLanes: true,
      })
      if (aliveRef.current) {
        setCreatedToken(result.token)
      }
    } catch (err) {
      // Step-up needed: the global prompt is already open, so no error toast.
      if (aliveRef.current && !isElevationRequiredError(err)) {
        toast.add({
          type: "error",
          title: "Failed to create invite",
          description: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      if (aliveRef.current) setInviting(false)
    }
  }, [everyCurrentLane, jwt, selectedProjectIds])

  const handleCopyToken = useCallback(() => {
    if (createdToken) {
      void navigator.clipboard.writeText(createdToken).then(() => {
        toast.add({ type: "success", title: "Token copied to clipboard" })
      })
    }
  }, [createdToken])

  const handleClose = () => {
    setCreatedToken(null)
    setSelectedProjectIds([])
    setEveryCurrentLane(false)
    setProjectSearch("")
    setIsOpen(false)
  }

  return (
    <Section
      title="Multi-project invite"
      description="Invite users to multiple projects in one token."
      action={<Button onClick={() => setIsOpen(true)}>Send invite</Button>}
    >
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{createdToken ? "Invite created" : "Create invite"}</DialogTitle>
          {createdToken ? (
            <div className="space-y-4">
              <div>
                <Label className="text-xs font-medium text-muted-foreground">Invite token</Label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="flex-1 text-xs bg-muted p-2 rounded truncate font-mono">{createdToken}</code>
                  <Button size="sm" variant="outline" onClick={handleCopyToken}>
                    Copy
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Share this token with the user to invite them.</p>
              <Button onClick={handleClose} className="w-full">
                Done
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <Label htmlFor="project-search" className="text-sm">
                  Projects (select at least one)
                </Label>
                <Input
                  id="project-search"
                  placeholder="Search projects"
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                  className="mb-2"
                />
                <div className="border rounded-lg max-h-48 overflow-y-auto space-y-1 p-2">
                  {filteredProjects.length > 0 ? (
                    filteredProjects.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 p-1 hover:bg-muted rounded cursor-pointer">
                        <Checkbox
                          checked={selectedProjectIds.includes(p.id)}
                          onCheckedChange={() => toggleProject(p.id)}
                        />
                        <span className="text-sm">{p.name}</span>
                      </label>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground p-2">No projects found</p>
                  )}
                </div>
                {selectedProjectIds.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-2">{selectedProjectIds.length} selected</p>
                )}
              </div>

              <label className="flex items-start gap-2 cursor-pointer">
                <Checkbox
                  checked={everyCurrentLane}
                  onCheckedChange={(checked) => setEveryCurrentLane(checked === true)}
                />
                <span className="text-sm">
                  {t("projectSettings.share.laneChoiceAll")}
                  <span className="block text-xs text-muted-foreground">
                    {t("projectSettings.share.laneChoiceAdminHint")}
                  </span>
                </span>
              </label>

              <Button
                onClick={handleInvite}
                disabled={selectedProjectIds.length === 0 || !everyCurrentLane || inviting}
                className="w-full"
              >
                {inviting ? "Creating..." : "Create invite"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Section>
  )
}
