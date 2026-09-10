import { useT } from "@/lib/i18n/I18nProvider"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel, FieldDescription, FieldGroup } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchSyncToken } from "@/lib/sync/sync-token"
import { checkingRequest, checkingUrl, createCheckingLink, loadCheckingFiles, type CheckingLink } from "@/lib/checking/api"
import { selectedUnits, type CheckingFile, type CheckingRole } from "@/lib/checking/scope"
import { CheckingScopePicker } from "./CheckingScopePicker"

export function CheckingLinkCreator({ projectId }: { projectId: string }) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt
  const [files, setFiles] = useState<CheckingFile[] | null>(null)
  const [selected, setSelected] = useState(new Set<string>())
  const [title, setTitle] = useState(t("projectSettings.checking.defaultTitle"))
  const [role, setRole] = useState<CheckingRole>("commenter")
  const [pin, setPin] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [links, setLinks] = useState<CheckingLink[]>([])
  const [copied, setCopied] = useState("")
  useEffect(() => {
    let current = true
    setFiles(null); setSelected(new Set()); setLinks([]); setError("")
    if (!jwt) { setError(t("projectSettings.checking.signIn")); return }
    void (async () => {
      const data = await loadCheckingFiles(jwt, projectId)
      const { token } = await fetchSyncToken(jwt, projectId, "any")
      const result = await checkingRequest<{ links: CheckingLink[] }>(`?projectId=${encodeURIComponent(projectId)}`, token)
      if (current) { setFiles(data); setLinks(result.links) }
    })().catch(error => { if (current) setError(String(error.message ?? error)) })
    return () => { current = false }
  }, [jwt, projectId, t])
  const units = selectedUnits(files ?? [], selected)
  async function create() {
    if (!jwt) return
    setBusy(true); setError("")
    try {
      const result = await createCheckingLink(jwt, { projectId, title, role, units, ...(pin ? { pin } : {}) })
      setLinks(previous => [{ ...result, title, role, revokedAt: null }, ...previous])
      setPin("")
    } catch (error) { setError(error instanceof Error ? error.message : t("projectSettings.checking.createFailed")) }
    finally { setBusy(false) }
  }
  async function revoke(token: string) {
    if (!jwt) return
    setBusy(true); setError("")
    try {
      const auth = await fetchSyncToken(jwt, projectId, "any")
      await checkingRequest(`/${token}/revoke`, auth.token, {})
      setLinks(previous => previous.map(link => link.token === token ? { ...link, revokedAt: Date.now() } : link))
    } catch (error) { setError(error instanceof Error ? error.message : t("projectSettings.checking.revokeFailed")) }
    finally { setBusy(false) }
  }
  return <div className="flex flex-col gap-4 rounded-lg border p-4">
    <h3 className="font-medium">{t("projectSettings.checking.creatorTitle")}</h3>
    <p className="text-sm text-muted-foreground">{t("projectSettings.checking.wipNotice")}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!files && !error && <p role="status">{t("projectSettings.checking.loadingProject")}</p>}
    {files && <>
      <FieldGroup>
        <Field><FieldLabel htmlFor="checking-title">{t("projectSettings.checking.linkTitle")}</FieldLabel><Input id="checking-title" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></Field>
        <Field><FieldLabel htmlFor="checking-role">{t("projectSettings.checking.guestAccess")}</FieldLabel>
          <Select value={role} onValueChange={value => { if (value) setRole(value as CheckingRole) }}>
            <SelectTrigger id="checking-role"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="viewer">{t("projectSettings.checking.viewerOption")}</SelectItem>
              <SelectItem value="commenter">{t("projectSettings.checking.commenterOption")}</SelectItem>
              <SelectItem value="reviewer">{t("projectSettings.checking.reviewerOption")}</SelectItem>
            </SelectGroup></SelectContent>
          </Select>
        </Field>
        <Field><FieldLabel htmlFor="checking-pin">{t("projectSettings.checking.pinOptional")}</FieldLabel><Input id="checking-pin" type="password" inputMode="numeric" autoComplete="new-password" value={pin} maxLength={12} onChange={event => setPin(event.target.value)} /><FieldDescription>{t("projectSettings.checking.pinHelp")}</FieldDescription></Field>
      </FieldGroup>
      <CheckingScopePicker files={files} selected={selected} onChange={setSelected} />
      <p className="text-sm text-muted-foreground">{t("projectSettings.checking.selectionSummary", { count: units.length })}</p>
      <Button disabled={busy || !title.trim() || !units.length || units.length > 2000 || (!!pin && !/^\d{4,12}$/.test(pin))} onClick={() => void create()}>{t("projectSettings.checking.createLink")}</Button>
    </>}
    {links.map(link => <div key={link.token} className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">{link.title} · {link.role}</p>
      {link.revokedAt ? <p className="text-sm text-muted-foreground">{t("projectSettings.checking.revoked")}</p> : <>
        <Input aria-label={t("projectSettings.checking.urlLabel", { title: link.title })} readOnly value={checkingUrl(link.token)} />
        <p className="text-xs text-muted-foreground">{t("projectSettings.checking.expires", { date: new Date(Number(link.expiresAt)).toLocaleDateString() })}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(checkingUrl(link.token)).then(() => setCopied(link.token)).catch(() => setError(t("projectSettings.checking.copyFailed"))) }}>{copied === link.token ? t("projectSettings.checking.copied") : t("projectSettings.checking.copyLink")}</Button>
          <Button variant="outline" nativeButton={false} render={<a href={checkingUrl(link.token)} target="_blank" rel="noreferrer" />}>{t("projectSettings.checking.openGuest")}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => void revoke(link.token)}>{t("projectSettings.checking.revoke")}</Button>
        </div>
      </>}
    </div>)}
  </div>
}
