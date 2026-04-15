import { useState } from "react"
import { GitBranch, LogIn, LogOut, User } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { FrontierLoginForm } from "./FrontierLoginForm"
import { useFrontierSession } from "@/hooks/useFrontierSession"

interface Props {
  onImportClick: () => void
}

export function HeaderAuth({ onImportClick }: Props) {
  const { session, loading, logout } = useFrontierSession()
  const [loginOpen, setLoginOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  if (loading) return null

  if (!session) {
    return (
      <>
        <Button variant="outline" size="sm" onClick={() => setLoginOpen(true)}>
          <LogIn className="h-4 w-4 mr-1.5" /> Log in
        </Button>
        <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Log in to Frontier</DialogTitle>
            </DialogHeader>
            <FrontierLoginForm onSuccess={() => setLoginOpen(false)} />
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return (
    <div className="relative">
      <Button variant="ghost" size="sm" onClick={() => setMenuOpen(v => !v)}>
        <User className="h-4 w-4 mr-1.5" /> {session.username}
      </Button>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 mt-1 w-48 rounded-md border bg-popover p-1 shadow-md z-20">
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => { setMenuOpen(false); onImportClick() }}
            >
              <GitBranch className="h-4 w-4" /> Import from git…
            </button>
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
              onClick={() => { setMenuOpen(false); logout() }}
            >
              <LogOut className="h-4 w-4" /> Log out
            </button>
          </div>
        </>
      )}
    </div>
  )
}
