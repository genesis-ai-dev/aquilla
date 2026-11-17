import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Section } from "@/components/ui/page"
import { AdminSectionSkeleton } from "./shared"
import {
  addAdminDevAccess,
  getAdminDevAccess,
  removeAdminDevAccess,
  type AdminDevAccessList,
} from "@/lib/frontier/admin"

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/

/**
 * AQU-2469: Platform-admin "Dev access". Who may sign in to dev.aquilla.app
 * besides the platform admins, who always can. Changes apply on the next
 * request, with no deploy. Off dev the list does nothing, and the page says so.
 */
export function AdminDevAccessSection({ jwt }: { jwt: string }) {
  const [list, setList] = useState<AdminDevAccessList | null>(null)
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await getAdminDevAccess(jwt)
      if (!aliveRef.current) return
      setList(next)
      setError(null)
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [jwt])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true)
      setError(null)
      try {
        await fn()
        await refresh()
        return true
      } catch (err) {
        if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
        return false
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    },
    [refresh],
  )

  if (!list && !error) return <AdminSectionSkeleton label="Loading dev access" blocks={1} />
  if (!list) return <p className="text-sm text-destructive">{error}</p>

  if (!list.enabled) {
    return (
      <p className="text-sm text-muted-foreground">
        Manage access to development and CI previews from this page on dev.aquilla.app.
      </p>
    )
  }

  const typed = email.trim().toLowerCase()
  const problem = typed && !EMAIL_RE.test(typed) ? "Enter a valid email address." : null

  const onAdd = async (e: FormEvent) => {
    e.preventDefault()
    if (!typed || problem) return
    if (await run(() => addAdminDevAccess(jwt, typed))) setEmail("")
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Only platform admins and the people listed here can sign in to dev.aquilla.app and updated CI previews. Platform
        admins don&apos;t need an entry. Changes may take a short time to reach every preview.
      </p>

      <Section title="People with dev access" description="The same list controls development and updated CI previews.">
        {list.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody yet. Only platform admins can sign in.</p>
        ) : (
          <ul className="divide-y">
            {list.entries.map((entry) => (
              <li key={entry.email} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0 space-y-0.5 text-sm">
                  <div className="break-all font-medium">{entry.email}</div>
                  {entry.addedBy && (
                    <div className="text-xs text-muted-foreground">
                      Added by {entry.addedBy}
                      {entry.addedAt ? ` on ${new Date(entry.addedAt).toLocaleDateString()}` : ""}
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  aria-label={`Remove ${entry.email}`}
                  onClick={() => {
                    if (window.confirm(`Remove ${entry.email}? They can't sign in to dev after this.`)) {
                      void run(() => removeAdminDevAccess(jwt, entry.email))
                    }
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <form className="space-y-2" onSubmit={(e) => void onAdd(e)}>
        <FieldLabel htmlFor="dev-access-email">Add someone</FieldLabel>
        <div className="flex flex-wrap gap-2">
          <Input
            id="dev-access-email"
            type="email"
            autoComplete="off"
            placeholder="name@example.com"
            className="max-w-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" disabled={busy || !typed || problem !== null}>
            Add
          </Button>
        </div>
        {problem && <p className="text-sm text-destructive">{problem}</p>}
      </form>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
