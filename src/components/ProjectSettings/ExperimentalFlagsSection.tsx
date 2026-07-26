// Experimental feature toggles (src/lib/features/flags.ts registry).
//
// Flags are DEVICE-LOCAL by design: they live on the IDB project record
// (`ProjectRecord.experimentalFlags`), never in ProjectWideSettings, so this
// section saves immediately via patchProject — no role floor, no deferred
// Save bar, no conflict with the shared-settings PATCH (mirrors the
// user-API-key immediate-save path in the parent page).

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { FLAGS } from "@/lib/features/flags"
import { getProject, patchProject } from "@/lib/store/project-index"

export function ExperimentalFlagsSection({ projectId }: { projectId: string }) {
  const [flags, setFlags] = useState<Record<string, boolean> | undefined>(undefined)

  // Seed from IDB directly — the parent's `project` comes from the server
  // read hook, which never carries device-local flags.
  useEffect(() => {
    let cancelled = false
    void getProject(projectId).then((local) => {
      if (!cancelled) setFlags(local?.experimentalFlags)
    })
    return () => { cancelled = true }
  }, [projectId])

  const setFlag = useCallback((key: string, value: boolean) => {
    setFlags((prev) => ({ ...prev, [key]: value }))
    void patchProject(projectId, (latest) => ({
      ...latest,
      experimentalFlags: { ...latest.experimentalFlags, [key]: value },
    }))
  }, [projectId])

  return (
    <Card id="section-experimental">
      <CardHeader>
        <CardTitle>Experimental</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Early features still in development. These switches stay on this device — they are not
          shared with collaborators.
        </p>
        {Object.entries(FLAGS).map(([key, def]) => (
          <div key={key} className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <FieldLabel htmlFor={`experimental-${key}`} className="text-sm">
                {def.label}
              </FieldLabel>
              <p className="text-xs text-muted-foreground">{def.description}</p>
            </div>
            <Switch
              id={`experimental-${key}`}
              checked={flags?.[key] ?? def.default}
              onCheckedChange={(checked) => setFlag(key, checked)}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
