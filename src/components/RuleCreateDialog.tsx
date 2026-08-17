import { useEffect, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
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
import { isFieldInvalid } from "@/lib/forms/field-state"
import { optionalString, requiredString } from "@/lib/forms/schemas"
import posthog from "@/lib/posthog"
import { useI18n } from "@/lib/i18n/I18nProvider"

type UserRuleCheckType = Exclude<RuleCheck["type"], "builtin">

const ruleSchema = z
  .object({
    name: requiredString("Rule name"),
    description: optionalString,
    severity: z.enum(["major", "minor"]),
    checkType: z.enum(["source-target-match", "source-requires-target", "target-forbids"]),
    pattern: optionalString,
    sourcePattern: optionalString,
    targetPattern: optionalString,
  })
  .superRefine((data, ctx) => {
    switch (data.checkType) {
      case "source-target-match":
        if (!data.pattern.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Pattern is required",
            path: ["pattern"],
          })
        }
        break
      case "target-forbids":
        if (!data.targetPattern.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Forbidden pattern is required",
            path: ["targetPattern"],
          })
        }
        break
      case "source-requires-target":
        if (!data.sourcePattern.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Source pattern is required",
            path: ["sourcePattern"],
          })
        }
        if (!data.targetPattern.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Required target pattern is required",
            path: ["targetPattern"],
          })
        }
        break
    }
  })

function buildCheck(
  checkType: UserRuleCheckType,
  pattern: string,
  sourcePattern: string,
  targetPattern: string,
): RuleCheck {
  switch (checkType) {
    case "source-target-match":
      return { type: "source-target-match", pattern }
    case "target-forbids":
      return { type: "target-forbids", targetPattern: targetPattern || pattern }
    case "source-requires-target":
      return { type: "source-requires-target", sourcePattern, targetPattern }
  }
}

interface RuleCreateDialogProps {
  onAdd: (rule: Omit<TranslationRule, "id" | "createdAt">) => void
  canManage?: boolean
  deniedReason?: string | null
}

export function RuleCreateDialog({
  onAdd,
  canManage = true,
  deniedReason,
}: RuleCreateDialogProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [testSource, setTestSource] = useState("")
  const [testTarget, setTestTarget] = useState("")
  const [testResult, setTestResult] = useState<string | null>(null)

  const form = useForm({
    defaultValues: {
      name: "",
      description: "",
      severity: "minor" as "major" | "minor",
      checkType: "source-target-match" as UserRuleCheckType,
      pattern: "",
      sourcePattern: "",
      targetPattern: "",
    },
    validators: { onSubmit: ruleSchema },
    onSubmit: ({ value }) => {
      const check = buildCheck(
        value.checkType,
        value.pattern,
        value.sourcePattern,
        value.targetPattern,
      )
      posthog.capture("translation rule created", {
        rule_name: value.name.trim(),
        severity: value.severity,
        check_type: check.type,
      })
      onAdd({
        name: value.name.trim(),
        description: value.description.trim(),
        severity: value.severity,
        source: "user",
        scope: "project",
        check,
        enabled: true,
      })
      setOpen(false)
    },
  })

  useEffect(() => {
    if (!open) return
    form.reset()
  }, [open, form])

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) {
      setTestSource("")
      setTestTarget("")
      setTestResult(null)
    }
  }

  function handleTest() {
    const values = form.state.values
    try {
      const check = buildCheck(
        values.checkType,
        values.pattern,
        values.sourcePattern,
        values.targetPattern,
      )
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <AppTooltip content={!canManage ? (deniedReason ?? undefined) : undefined} disabled={canManage || !deniedReason}>
        <DialogTrigger
          render={
            <Button
              disabled={!canManage}
            />
          }
        >
          <Plus className="size-4" aria-hidden />
          {t("rules.surface.addRuleButton")}
        </DialogTrigger>
      </AppTooltip>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t("rules.surface.createRuleDialog.title")}</DialogTitle></DialogHeader>
        <form
          id="rule-create-form"
          onSubmit={(e) => {
            e.preventDefault()
            void form.handleSubmit()
          }}
          className="flex flex-col gap-3"
        >
          <FieldGroup>
            <form.Field
              name="name"
              children={(field) => {
                const invalid = isFieldInvalid(field)
                return (
                  <Field data-invalid={invalid}>
                    <FieldLabel htmlFor="rname">{t("rules.editor.nameLabel")}</FieldLabel>
                    <Input
                      id="rname"
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder={t("rules.createDialog.namePlaceholder")}
                      aria-invalid={invalid}
                    />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            />
            <form.Field
              name="description"
              children={(field) => (
                <Field>
                  <FieldLabel htmlFor="rdesc">{t("rules.createDialog.descriptionLabel")}</FieldLabel>
                  <Input
                    id="rdesc"
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={t("rules.editor.descriptionPlaceholder")}
                  />
                </Field>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <form.Field
                name="severity"
                children={(field) => (
                  <Field>
                    <FieldLabel>{t("rules.editor.severityLabel")}</FieldLabel>
                    <Select
                      items={{ minor: t("rules.severity.minor"), major: t("rules.severity.major") }}
                      value={field.state.value}
                      onValueChange={(value) => field.handleChange(value as "major" | "minor")}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="minor">{t("rules.severity.minor")}</SelectItem>
                          <SelectItem value="major">{t("rules.severity.major")}</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              <form.Field
                name="checkType"
                children={(field) => (
                  <Field>
                    <FieldLabel>{t("rules.createDialog.ruleTypeLabel")}</FieldLabel>
                    <Select
                      items={{
                        "source-target-match": t("rules.createDialog.checkType.sourceTargetMatch"),
                        "source-requires-target": t("rules.createDialog.checkType.sourceRequiresTarget"),
                        "target-forbids": t("rules.createDialog.checkType.targetForbids"),
                      }}
                      value={field.state.value}
                      onValueChange={(value) => field.handleChange(value as UserRuleCheckType)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="source-target-match">{t("rules.createDialog.checkType.sourceTargetMatch")}</SelectItem>
                          <SelectItem value="source-requires-target">{t("rules.createDialog.checkType.sourceRequiresTarget")}</SelectItem>
                          <SelectItem value="target-forbids">{t("rules.createDialog.checkType.targetForbids")}</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
            </div>

            <form.Subscribe
              selector={(state) => state.values.checkType}
              children={(checkType) => (
                <>
                  {checkType === "source-target-match" && (
                    <form.Field
                      name="pattern"
                      children={(field) => {
                        const invalid = isFieldInvalid(field)
                        return (
                          <Field data-invalid={invalid}>
                            <FieldLabel htmlFor="pat">{t("rules.createDialog.patternRegexLabel")}</FieldLabel>
                            <Input
                              id="pat"
                              name={field.name}
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(e) => field.handleChange(e.target.value)}
                              placeholder="\\d+"
                              className="font-mono text-xs"
                              aria-invalid={invalid}
                            />
                            <FieldDescription>{t("rules.createDialog.patternFieldHint.match")}</FieldDescription>
                            {invalid && <FieldError errors={field.state.meta.errors} />}
                          </Field>
                        )
                      }}
                    />
                  )}
                  {checkType === "target-forbids" && (
                    <form.Field
                      name="targetPattern"
                      children={(field) => {
                        const invalid = isFieldInvalid(field)
                        return (
                          <Field data-invalid={invalid}>
                            <FieldLabel htmlFor="tpat">{t("rules.createDialog.forbiddenPatternRegexLabel")}</FieldLabel>
                            <Input
                              id="tpat"
                              name={field.name}
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(e) => field.handleChange(e.target.value)}
                              placeholder="\\b(the|a|an)\\b" // i18n-exempt regex literal example, not natural-language text
                              className="font-mono text-xs"
                              aria-invalid={invalid}
                            />
                            <FieldDescription>{t("rules.createDialog.patternFieldHint.forbidden")}</FieldDescription>
                            {invalid && <FieldError errors={field.state.meta.errors} />}
                          </Field>
                        )
                      }}
                    />
                  )}
                  {checkType === "source-requires-target" && (
                    <>
                      <form.Field
                        name="sourcePattern"
                        children={(field) => {
                          const invalid = isFieldInvalid(field)
                          return (
                            <Field data-invalid={invalid}>
                              <FieldLabel htmlFor="spat">{t("rules.createDialog.sourcePatternRegexLabel")}</FieldLabel>
                              <Input
                                id="spat"
                                name={field.name}
                                value={field.state.value}
                                onBlur={field.handleBlur}
                                onChange={(e) => field.handleChange(e.target.value)}
                                placeholder="\\d+"
                                className="font-mono text-xs"
                                aria-invalid={invalid}
                              />
                              {invalid && <FieldError errors={field.state.meta.errors} />}
                            </Field>
                          )
                        }}
                      />
                      <form.Field
                        name="targetPattern"
                        children={(field) => {
                          const invalid = isFieldInvalid(field)
                          return (
                            <Field data-invalid={invalid}>
                              <FieldLabel htmlFor="tpat2">{t("rules.createDialog.requiredTargetPatternRegexLabel")}</FieldLabel>
                              <Input
                                id="tpat2"
                                name={field.name}
                                value={field.state.value}
                                onBlur={field.handleBlur}
                                onChange={(e) => field.handleChange(e.target.value)}
                                placeholder="\\d+"
                                className="font-mono text-xs"
                                aria-invalid={invalid}
                              />
                              {invalid && <FieldError errors={field.state.meta.errors} />}
                            </Field>
                          )
                        }}
                      />
                    </>
                  )}
                </>
              )}
            />
          </FieldGroup>

          {/* Test area */}
          <div className="rounded border bg-muted/30 p-3 flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">{t("rules.createDialog.testYourRuleHeading")}</p>
            <Input value={testSource} onChange={(e) => setTestSource(e.target.value)} placeholder={t("rules.createDialog.testSourcePlaceholder")} className="text-xs" />
            <Input value={testTarget} onChange={(e) => setTestTarget(e.target.value)} placeholder={t("rules.createDialog.testTargetPlaceholder")} className="text-xs" />
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={handleTest}>{t("rules.createDialog.testButton")}</Button>
              {testResult && (
                <span className={`text-xs ${testResult.startsWith("✓") ? "text-green-600" : testResult.startsWith("✗") ? "text-destructive" : "text-amber-600"}`}>
                  {testResult}
                </span>
              )}
            </div>
          </div>

          <Button type="submit" form="rule-create-form" className="w-full">
            {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
            {t("rules.editor.createRuleButton")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
