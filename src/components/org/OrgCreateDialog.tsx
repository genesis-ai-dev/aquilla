import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { createOrg } from "@/lib/frontier/orgs"
import posthog from "@/lib/posthog"
import { ORG_CREATED } from "@/lib/event-names"

interface OrgCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (orgId: number) => void
}

export function OrgCreateDialog({ open, onOpenChange, onCreated }: OrgCreateDialogProps) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName("")
    setError(null)
  }, [open])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!jwt || !trimmed || creating) return
    setCreating(true)
    setError(null)
    try {
      const org = await createOrg(jwt, trimmed)
      posthog.capture(ORG_CREATED, { org_id: org.id })
      onCreated(org.id)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create your organization.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create organization</DialogTitle>
          <DialogDescription>
            Give your team a workspace for projects, members, and settings.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="org-create-name">Organization name</FieldLabel>
              <Input
                id="org-create-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Bible Translation"
                autoFocus
              />
            </Field>
          </FieldGroup>
          {error ? <FieldError role="alert">{error}</FieldError> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !name.trim()}>
              {creating ? "Creating…" : "Create organization"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
