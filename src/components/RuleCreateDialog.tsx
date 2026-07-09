import { useEffect, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { Button } from "@/components/ui/button"
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
}

export function RuleCreateDialog({ onAdd }: RuleCreateDialogProps) {
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
      <DialogTrigger render={<Button size="sm" />}>
        + Add Rule
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Create Translation Rule</DialogTitle></DialogHeader>
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
                    <FieldLabel htmlFor="rname">Rule Name</FieldLabel>
                    <Input
                      id="rname"
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="Preserve numbers"
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
                  <FieldLabel htmlFor="rdesc">Description</FieldLabel>
                  <Input
                    id="rdesc"
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder="Numbers in source must appear in target"
                  />
                </Field>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <form.Field
                name="severity"
                children={(field) => (
                  <Field>
                    <FieldLabel>Severity</FieldLabel>
                    <Select
                      items={{ minor: "Minor", major: "Major" }}
                      value={field.state.value}
                      onValueChange={(value) => field.handleChange(value as "major" | "minor")}
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
                )}
              />
              <form.Field
                name="checkType"
                children={(field) => (
                  <Field>
                    <FieldLabel>Rule Type</FieldLabel>
                    <Select
                      items={{
                        "source-target-match": "Source-target match",
                        "source-requires-target": "Source requires target",
                        "target-forbids": "Target forbids",
                      }}
                      value={field.state.value}
                      onValueChange={(value) => field.handleChange(value as UserRuleCheckType)}
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
                            <FieldLabel htmlFor="pat">Pattern (regex)</FieldLabel>
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
                            <FieldDescription>Must appear in both source and target</FieldDescription>
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
                            <FieldLabel htmlFor="tpat">Forbidden pattern (regex)</FieldLabel>
                            <Input
                              id="tpat"
                              name={field.name}
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(e) => field.handleChange(e.target.value)}
                              placeholder="\\b(the|a|an)\\b"
                              className="font-mono text-xs"
                              aria-invalid={invalid}
                            />
                            <FieldDescription>Target must not contain this</FieldDescription>
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
                              <FieldLabel htmlFor="spat">Source pattern (regex)</FieldLabel>
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
                              <FieldLabel htmlFor="tpat2">Required target pattern (regex)</FieldLabel>
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

          <Button type="submit" form="rule-create-form" className="w-full">
            {form.state.isSubmitting && <Spinner data-icon="inline-start" />}
            Create Rule
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
