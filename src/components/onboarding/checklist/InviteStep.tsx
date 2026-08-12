import { useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { Copy, Plus, UserPlus, Check, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Input } from "@/components/ui/input"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { createServerInvite } from "@/lib/sync/invites"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { ROLE, resolveRoleName } from "@/lib/frontier/roles"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { requiredString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"
import { useT } from "@/lib/i18n/I18nProvider"

const inviteSchema = z.object({
  username: requiredString("Username"),
})

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
  const t = useT()
  const { session } = useFrontierSession()
  const { add, error: memberError } = useProjectMembers(projectId)
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const [addedUsername, setAddedUsername] = useState<string | null>(null)

  const [linkBusy, setLinkBusy] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const form = useForm({
    defaultValues: { username: "" },
    validators: { onSubmit: inviteSchema },
    onSubmit: async ({ value }) => {
      clearSubmitError()
      setAddedUsername(null)
      if (!session?.jwt) {
        setSubmitError(t("onboarding.checklist.invite.signInRequired"))
        return
      }
      const trimmed = value.username.trim()
      try {
        const member = await add(trimmed, ROLE.CONTRIBUTOR)
        if (!member) {
          setSubmitError(t("onboarding.checklist.invite.noSuchUser", { username: trimmed }))
        } else {
          setAddedUsername(member.username)
          form.reset()
          onSharesChanged()
        }
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : t("onboarding.checklist.invite.addFailed"))
      }
    },
  })

  async function handleCreateLink() {
    setLinkError(null)
    if (!session?.jwt) {
      setLinkError(t("onboarding.checklist.invite.linkSignInRequired"))
      return
    }
    setLinkBusy(true)
    try {
      const serverInvite = await createServerInvite(session.jwt, projectId, ROLE.CONTRIBUTOR)
      if (!serverInvite) {
        setLinkError(t("onboarding.checklist.invite.linkCreateFailed"))
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
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {t("onboarding.checklist.invite.descriptionPrefix")}{" "}
        <strong>{resolveRoleName(t, ROLE.CONTRIBUTOR, { plural: true })}</strong>{" "}
        {t("onboarding.checklist.invite.descriptionSuffix")}
      </p>

      {/* Direct username invite */}
      <form
        id="invite-member-form"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
        className="flex flex-col gap-2"
      >
        <FieldGroup>
          <form.Field
            name="username"
            children={(field) => {
              const invalid = isFieldInvalid(field)
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor="invite-user" className="text-xs">
                    {t("onboarding.checklist.invite.usernameLabel")}
                  </FieldLabel>
                  <div className="flex gap-1.5">
                    <Input
                      id="invite-user"
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder={t("onboarding.checklist.invite.usernamePlaceholder")}
                      className="text-sm"
                      aria-invalid={invalid}
                      disabled={form.state.isSubmitting || !session?.jwt}
                    />
                    <Button
                      type="submit"
                      form="invite-member-form"
                      size="sm"
                      disabled={form.state.isSubmitting || !session?.jwt}
                    >
                      {form.state.isSubmitting ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <UserPlus className="me-1 h-3.5 w-3.5" />
                      )}
                      {t("common.add")}
                    </Button>
                  </div>
                  {invalid && <FieldError errors={field.state.meta.errors} className="text-xs" />}
                </Field>
              )
            }}
          />
        </FieldGroup>
        {!session?.jwt && (
          <p className="text-[11px] text-muted-foreground">
            {t("onboarding.checklist.invite.signInRequired")}
          </p>
        )}
        {addedUsername && (
          <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <Check className="h-3 w-3" /> {t("onboarding.checklist.invite.addedPrefix")}{" "}
            <strong>{addedUsername}</strong>{" "}
            {t("onboarding.checklist.invite.addedSuffix")}
          </p>
        )}
        {submitError && (
          <p className="flex items-start gap-1 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{submitError}</span>
          </p>
        )}
        {memberError && !submitError && !addedUsername && (
          <p className="text-xs text-destructive">{memberError}</p>
        )}
      </form>

      {/* Share-link path */}
      <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">{t("onboarding.checklist.invite.shareLinkLabel")}</span>
          {!issuedUrl && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleCreateLink}
              disabled={linkBusy || !session?.jwt}
              className="h-7"
            >
              <Plus className="me-1 h-3 w-3" />
              {linkBusy ? t("onboarding.common.creating") : t("onboarding.checklist.invite.createLinkButton")}
            </Button>
          )}
        </div>
        {issuedUrl ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <Input value={issuedUrl} readOnly className="h-7 text-[11px] font-mono" />
              <AppTooltip content={copied ? t("nav.report.copied") : t("onboarding.common.copy")}>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => copyUrl(issuedUrl)}
                  className="h-7 w-7 p-0"
                  aria-label={copied ? t("nav.version.copiedLabel") : t("onboarding.checklist.invite.copyLinkAriaLabel")}
                >
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-600" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
              </AppTooltip>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => { setIssuedUrl(null); setCopied(false) }}
              className="h-7 w-full text-xs"
            >
              <Plus className="me-1 h-3 w-3" />
              {t("onboarding.checklist.invite.createAnotherLink")}
            </Button>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {t("onboarding.checklist.invite.shareLinkHint")}
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
