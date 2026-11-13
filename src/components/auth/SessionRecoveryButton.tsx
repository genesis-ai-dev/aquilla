import { useState } from "react"
import { useLocation } from "react-router-dom"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FrontierLoginForm } from "@/components/git-import/FrontierLoginForm"
import { FrontierForgotPasswordForm } from "@/components/git-import/FrontierForgotPasswordForm"
import { useT } from "@/lib/i18n/I18nProvider"

/** Reauthenticate in place, preserving the page and all local account data. */
export function SessionRecoveryButton({ username, className }: { username?: string; className?: string }) {
  const t = useT()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [forgot, setForgot] = useState(false)
  return <>
    <button type="button" className={className} onClick={() => { setForgot(false); setOpen(true) }}>{t("auth.sessionExpired.signInAgain")}</button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{t(forgot ? "auth.resetPassword.title" : "nav.account.loginTitle")}</DialogTitle></DialogHeader>
        {forgot
          ? <FrontierForgotPasswordForm onBack={() => setForgot(false)} returnTo={location.pathname + location.search} />
          : <FrontierLoginForm returnTo={location.pathname + location.search} navigateOnSuccess={false} initialUsername={username} onSuccess={() => setOpen(false)} onForgotPassword={() => setForgot(true)} />}
      </DialogContent>
    </Dialog>
  </>
}
