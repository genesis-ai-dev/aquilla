import { User, Users } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Personal vs Team fork (PLG research: segment intent early, then bifurcate the
 * flow). Personal users go straight to creating a project in their personal
 * workspace; Team users first create an organization and invite collaborators,
 * because for a collaborative product the multiplayer setup is the real value.
 */
export function IntentStep({
  onChoosePersonal,
  onChooseTeam,
  onBack,
}: {
  onChoosePersonal: () => void
  onChooseTeam: () => void
  onBack: () => void
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold">How will you use Aquilla?</h2>
        <p className="text-sm text-muted-foreground">
          This just tailors your setup — you can change it later.
        </p>
      </div>
      <div className="grid gap-3">
        <button
          type="button"
          onClick={onChoosePersonal}
          className="flex items-start gap-3 rounded-lg border p-4 text-left hover:border-primary hover:bg-accent"
        >
          <User className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <span className="block text-sm font-medium">Just me</span>
            <span className="block text-xs text-muted-foreground">
              A personal workspace to translate on my own.
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onChooseTeam}
          className="flex items-start gap-3 rounded-lg border p-4 text-left hover:border-primary hover:bg-accent"
        >
          <Users className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <span className="block text-sm font-medium">My team</span>
            <span className="block text-xs text-muted-foreground">
              Set up an organization and invite collaborators to translate together.
            </span>
          </span>
        </button>
      </div>
      <Button variant="ghost" size="sm" onClick={onBack} className="w-full">
        ← Back
      </Button>
    </div>
  )
}
