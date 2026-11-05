/**
 * AQU-2342: Project settings → AI's two doors to what the AI is given — the
 * one Instructions text and the one Checks list. Both live on the Living
 * Memory surface; these rows are real navigations out of settings (no modal
 * `state`), and they render while searching too, so a search for "brief",
 * "prompt" or "rules" produces the path to them (AQU-1672).
 */
import { ShieldCheck } from "lucide-react"
import { NavList, NavRow } from "@/components/ui/nav-list"
import { BRIEF_ICON } from "@/components/LivingMemoryButton"
import { useT } from "@/lib/i18n/I18nProvider"
import { projectMemoryPath } from "@/lib/navigation/org-paths"

export function InstructionsRow({ projectId, resolvedInstructions }: { projectId: string; resolvedInstructions: string }) {
  const t = useT()
  return (
    <div id="section-instructions" className="flex flex-col gap-12">
      <NavList>
        <NavRow
          to={projectMemoryPath(projectId, "instructions")}
          icon={BRIEF_ICON}
          title={t("terminology.livingMemory.instructionsTitle")}
          description={
            resolvedInstructions
              ? resolvedInstructions.slice(0, 240).replace(/\s+/g, " ")
              : t("terminology.livingMemory.instructions.notWritten")
          }
        />
      </NavList>
    </div>
  )
}

export function ChecksRow({ projectId }: { projectId: string }) {
  const t = useT()
  return (
    <div id="section-checks" className="flex flex-col gap-12">
      <NavList>
        <NavRow
          to={projectMemoryPath(projectId, "checks")}
          icon={ShieldCheck}
          title={t("terminology.livingMemory.section.checks.title")}
          description={t("terminology.livingMemory.section.checks.description")}
        />
      </NavList>
    </div>
  )
}
