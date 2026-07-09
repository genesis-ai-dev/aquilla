import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { TranslationRule, RuleCheck } from "@/lib/parsers/types"
import posthog from "@/lib/posthog"

interface RuleCreateDialogProps {
  onAdd: (rule: Omit<TranslationRule, "id" | "createdAt">) => void
  /**
   * AQU-480: creating a rule persists to project_settings (MAINTAINER-gated on
   * the server). When false, the trigger is disabled-with-tooltip so a
   * below-floor user can't open the dialog and add a rule that silently 403s
   * and vanishes on reload. Defaults true.
   */
  canManage?: boolean
  deniedReason?: string | null
}

export function RuleCreateDialog({ onAdd, canManage = true, deniedReason }: RuleCreateDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [severity, setSeverity] = useState<"major" | "minor">("minor")
  // The dialog creates user-defined regex rules; builtin checks are code-defined
  // and surfaced elsewhere, so they're excluded from the picker here.
  const [checkType, setCheckType] = useState<Exclude<RuleCheck["type"], "builtin">>("source-target-match")
  const [pattern, setPattern] = useState("")
  const [sourcePattern, setSourcePattern] = useState("")
  const [targetPattern, setTargetPattern] = useState("")
  const [testSource, setTestSource] = useState("")
  const [testTarget, setTestTarget] = useState("")
  const [testResult, setTestResult] = useState<string | null>(null)

  function buildCheck(): RuleCheck {
    switch (checkType) {
      case "source-target-match":
        return { type: "source-target-match", pattern }
      case "target-forbids":
        return { type: "target-forbids", targetPattern: targetPattern || pattern }
      case "source-requires-target":
        return { type: "source-requires-target", sourcePattern, targetPattern }
    }
  }

  function handleTest() {
    try {
      const check = buildCheck()
      let pass = true
      let msg = ""
      switch (check.type) {
        case "target-forbids": {
          const re = new RegExp(check.targetPattern, "i")
          if (re.test(testTarget)) { pass = false; msg = "Target contains forbidden pattern" }
          else msg = "Pass — pattern not found in target"
          break
        }
        case "source-requires-target": {
          const sre = new RegExp(check.sourcePattern, "i")
          if (!sre.test(testSource)) { msg = "Source doesn't match — rule doesn't apply" }
          else {
            const tre = new RegExp(check.targetPattern, "i")
            if (!tre.test(testTarget)) { pass = false; msg = "Source matches but target doesn't" }
            else msg = "Pass — both match"
          }
          break
        }
        case "source-target-match": {
          const re = new RegExp(check.pattern, "gi")
          const sm = testSource.match(re)
          if (!sm) { msg = "Source doesn't match — rule doesn't apply" }
          else {
            const tm = testTarget.match(re)
            if (!tm) { pass = false; msg = `Found "${sm[0]}" in source but not in target` }
            else msg = "Pass — pattern found in both"
          }
          break
        }
      }
      setTestResult(pass ? `✓ ${msg}` : `✗ ${msg}`)
    } catch (e) {
      setTestResult(`Error: ${e instanceof Error ? e.message : "Invalid regex"}`)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    const check = buildCheck()
    posthog.capture("translation rule created", {
      rule_name: name.trim(),
      severity,
      check_type: check.type,
    })
    onAdd({
      name: name.trim(),
      description: description.trim(),
      severity,
      source: "user",
      scope: "project",
      check,
      enabled: true,
    })
    setOpen(false)
    setName(""); setDescription(""); setPattern(""); setSourcePattern(""); setTargetPattern("")
    setTestSource(""); setTestTarget(""); setTestResult(null)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            size="sm"
            disabled={!canManage}
            title={!canManage ? (deniedReason ?? undefined) : undefined}
          />
        }
      >
        + Add Rule
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Create Translation Rule</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="rname">Rule Name</FieldLabel>
              <Input id="rname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Preserve numbers" />
            </Field>
            <Field>
              <FieldLabel htmlFor="rdesc">Description</FieldLabel>
              <Input id="rdesc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Numbers in source must appear in target" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel>Severity</FieldLabel>
                <Select
                  items={{ minor: "Minor", major: "Major" }}
                  value={severity}
                  onValueChange={(value) => setSeverity(value as "major" | "minor")}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="minor">Minor</SelectItem>
                      <SelectItem value="major">Major</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Rule Type</FieldLabel>
                <Select
                  items={{
                    "source-target-match": "Source-target match",
                    "source-requires-target": "Source requires target",
                    "target-forbids": "Target forbids",
                  }}
                  value={checkType}
                  onValueChange={(value) => setCheckType(value as Exclude<RuleCheck["type"], "builtin">)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="source-target-match">Source-target match</SelectItem>
                      <SelectItem value="source-requires-target">Source requires target</SelectItem>
                      <SelectItem value="target-forbids">Target forbids</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {checkType === "source-target-match" && (
              <Field>
                <FieldLabel htmlFor="pat">Pattern (regex)</FieldLabel>
                <Input id="pat" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="\\d+" className="font-mono text-xs" />
                <FieldDescription>Must appear in both source and target</FieldDescription>
              </Field>
            )}
            {checkType === "target-forbids" && (
              <Field>
                <FieldLabel htmlFor="tpat">Forbidden pattern (regex)</FieldLabel>
                <Input id="tpat" value={targetPattern} onChange={(e) => setTargetPattern(e.target.value)} placeholder="\\b(the|a|an)\\b" className="font-mono text-xs" />
                <FieldDescription>Target must not contain this</FieldDescription>
              </Field>
            )}
            {checkType === "source-requires-target" && (
              <>
                <Field>
                  <FieldLabel htmlFor="spat">Source pattern (regex)</FieldLabel>
                  <Input id="spat" value={sourcePattern} onChange={(e) => setSourcePattern(e.target.value)} placeholder="\\d+" className="font-mono text-xs" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tpat2">Required target pattern (regex)</FieldLabel>
                  <Input id="tpat2" value={targetPattern} onChange={(e) => setTargetPattern(e.target.value)} placeholder="\\d+" className="font-mono text-xs" />
                </Field>
              </>
            )}
          </FieldGroup>

          {/* Test area */}
          <div className="rounded border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Test your rule</p>
            <Input value={testSource} onChange={(e) => setTestSource(e.target.value)} placeholder="Source text..." className="text-xs" />
            <Input value={testTarget} onChange={(e) => setTestTarget(e.target.value)} placeholder="Target text..." className="text-xs" />
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={handleTest}>Test</Button>
              {testResult && (
                <span className={`text-xs ${testResult.startsWith("✓") ? "text-green-600" : testResult.startsWith("✗") ? "text-destructive" : "text-amber-600"}`}>
                  {testResult}
                </span>
              )}
            </div>
          </div>

          <Button type="submit" className="w-full" disabled={!name.trim()}>Create Rule</Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
