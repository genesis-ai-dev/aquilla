import { useEffect, useRef, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { SettingsGroup } from "@/components/ui/page"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { optionalString, requiredString } from "@/lib/forms/schemas"
import {
  clearUserProviderOverride,
  getUserProviderOverride,
  setUserProviderOverride,
} from "@/lib/store/user-provider-override"

const formSchema = z.object({
  endpoint: requiredString("Endpoint URL"),
  model: optionalString,
  apiKey: optionalString,
})

/**
 * Advanced, opt-in: a personal AI provider override that beats per-project
 * settings on this device only. Hidden behind a disclosure so the default
 * Settings view stays uncluttered for users on the happy path (Frontier
 * managed model + sign-in).
 */
export function PersonalProviderSection() {
  const [open, setOpen] = useState(false)
  const [hasOverride, setHasOverride] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const form = useForm({
    defaultValues: {
      endpoint: "",
      model: "",
      apiKey: "",
    },
    validators: { onSubmit: formSchema },
    onSubmit: ({ value }) => {
      setUserProviderOverride({
        endpoint: value.endpoint.trim(),
        model: value.model.trim() || undefined,
        apiKey: value.apiKey.trim() || undefined,
      })
      setHasOverride(true)
      setSaved(true)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setSaved(false), 2500)
    },
  })

  useEffect(() => {
    const existing = getUserProviderOverride()
    if (existing) {
      form.setFieldValue("endpoint", existing.endpoint)
      form.setFieldValue("model", existing.model ?? "")
      form.setFieldValue("apiKey", existing.apiKey ?? "")
      setHasOverride(true)
      setOpen(true)
    }
  }, [form])

  function handleClear() {
    clearUserProviderOverride()
    form.reset()
    setHasOverride(false)
  }

  return (
    <SettingsGroup label="Personal override">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-start gap-3 px-5 py-4 text-left hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset">
          {open ? (
            <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">
              AI provider (advanced)
            </p>
            <p className="text-xs text-muted-foreground">
              {hasOverride
                ? "Active — your projects use this endpoint on this device."
                : "Optional. Most users should leave this off and use Frontier."}
            </p>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <form
            id="personal-provider-form"
            className="flex flex-col gap-4 border-t px-5 pb-4 pt-4"
            onSubmit={(e) => {
              e.preventDefault()
              void form.handleSubmit()
            }}
          >
            <p className="text-xs text-muted-foreground">
              Use your own OpenAI-compatible endpoint instead of Frontier for AI
              translations. Stored only in this browser, never synced. Overrides
              any project-level provider setting.
            </p>

            <FieldGroup>
              <form.Field
                name="endpoint"
                children={(field) => {
                  const invalid = isFieldInvalid(field)
                  return (
                    <Field data-invalid={invalid}>
                      <FieldLabel htmlFor="prov-endpoint">Endpoint URL</FieldLabel>
                      <Input
                        id="prov-endpoint"
                        name={field.name}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder="https://openrouter.ai/api/v1"
                        aria-invalid={invalid}
                        autoComplete="off"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Trailing <code className="font-mono">/v1</code> or{" "}
                        <code className="font-mono">/chat/completions</code> is fine.
                      </p>
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              />

              <form.Field
                name="model"
                children={(field) => (
                  <Field>
                    <FieldLabel htmlFor="prov-model">
                      Model <span className="text-muted-foreground/70">(optional)</span>
                    </FieldLabel>
                    <Input
                      id="prov-model"
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="gpt-4o-mini"
                      autoComplete="off"
                    />
                  </Field>
                )}
              />

              <form.Field
                name="apiKey"
                children={(field) => (
                  <Field>
                    <FieldLabel htmlFor="prov-key">
                      API key <span className="text-muted-foreground/70">(optional)</span>
                    </FieldLabel>
                    <Input
                      id="prov-key"
                      name={field.name}
                      type="password"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="sk-…"
                      autoComplete="off"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Sent as <code className="font-mono">Authorization: Bearer …</code>.
                      Leave blank for unauthenticated local endpoints.
                    </p>
                  </Field>
                )}
              />
            </FieldGroup>

            <div className="flex items-center justify-between gap-2 pt-2">
              <div className="flex items-center gap-3">
                <Button type="submit" form="personal-provider-form" size="sm">
                  {hasOverride ? "Update override" : "Save override"}
                </Button>
                {saved && (
                  <span className="text-xs text-green-600 dark:text-green-400" role="status" data-testid="provider-override-saved">
                    Saved
                  </span>
                )}
              </div>
              {hasOverride && (
                <Button type="button" variant="ghost" size="sm" onClick={handleClear}>
                  Remove override
                </Button>
              )}
            </div>
          </form>
        </CollapsibleContent>
      </Collapsible>
    </SettingsGroup>
  )
}
