import { useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { CheckCircle2, Search, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { SettingsGroup } from "@/components/ui/page"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { requiredString } from "@/lib/forms/schemas"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import {
  DEFAULT_LOCAL_LLM_SETTINGS,
  setLocalLlmSettings,
  useLocalLlmSettings,
} from "@/lib/offline/llm-settings"
import { listLocalLlmModels, testLocalLlmConnection } from "@/lib/offline/local-llm-client"

const formSchema = z.object({
  endpoint: requiredString("Endpoint URL"),
  model: requiredString("Model"),
})

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "result"; ok: boolean; message: string }

type DetectState =
  | { kind: "idle" }
  | { kind: "detecting" }
  | { kind: "found-one"; model: string }
  | { kind: "found-many"; models: string[] }
  | { kind: "found-none" }
  | { kind: "error"; message: string }

/**
 * Desktop-only (Tauri) settings for the local LLM used when offline —
 * proxied through `src-tauri/src/llm_proxy.rs`. Renders nothing in the
 * browser SPA, where there is no local proxy to configure.
 */
export function LocalLlmSection() {
  const { t } = useI18n()
  const settings = useLocalLlmSettings()
  const [testState, setTestState] = useState<TestState>({ kind: "idle" })
  const [detectState, setDetectState] = useState<DetectState>({ kind: "idle" })

  const form = useForm({
    defaultValues: { endpoint: settings.endpoint, model: settings.model },
    validators: { onSubmit: formSchema },
    onSubmit: ({ value }) => {
      setLocalLlmSettings({ endpoint: value.endpoint.trim(), model: value.model.trim() })
      setTestState({ kind: "idle" })
    },
  })

  if (!isTauriRuntime()) return null

  async function handleTestConnection() {
    setTestState({ kind: "testing" })
    const result = await testLocalLlmConnection({
      endpoint: form.getFieldValue("endpoint").trim() || DEFAULT_LOCAL_LLM_SETTINGS.endpoint,
      model: form.getFieldValue("model").trim() || DEFAULT_LOCAL_LLM_SETTINGS.model,
    })
    setTestState({ kind: "result", ok: result.ok, message: result.message })
  }

  async function handleDetectModels() {
    setDetectState({ kind: "detecting" })
    const endpoint = form.getFieldValue("endpoint").trim() || DEFAULT_LOCAL_LLM_SETTINGS.endpoint
    try {
      const models = await listLocalLlmModels(endpoint)
      if (models.length === 0) {
        setDetectState({ kind: "found-none" })
      } else if (models.length === 1) {
        form.setFieldValue("model", models[0])
        setDetectState({ kind: "found-one", model: models[0] })
      } else {
        setDetectState({ kind: "found-many", models })
      }
    } catch (error) {
      setDetectState({
        kind: "error",
        message: error instanceof Error ? error.message : "Detection failed.",
      })
    }
  }

  function pickDetectedModel(model: string) {
    form.setFieldValue("model", model)
    setDetectState({ kind: "found-one", model })
  }

  return (
    <SettingsGroup label={t("settings.localLlm.groupLabel")}>
      <form
        id="local-llm-form"
        className="flex flex-col gap-4 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
      >
        <p className="text-xs text-muted-foreground">{t("settings.localLlm.description")}</p>

        <FieldGroup>
          <form.Field
            name="endpoint"
            children={(field) => {
              const invalid = isFieldInvalid(field)
              return (
                <Field data-invalid={invalid}>
                  <FieldLabel htmlFor="local-llm-endpoint">
                    {t("projectSettings.advancedLlm.endpointLabel")}
                  </FieldLabel>
                  <Input
                    id="local-llm-endpoint"
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    placeholder={DEFAULT_LOCAL_LLM_SETTINGS.endpoint}
                    aria-invalid={invalid}
                    autoComplete="off"
                  />
                  {invalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              )
            }}
          />

          <form.Field
            name="model"
            children={(field) => {
              const invalid = isFieldInvalid(field)
              return (
                <Field data-invalid={invalid}>
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel htmlFor="local-llm-model">
                      {t("projectSettings.advancedLlm.modelLabel")}
                    </FieldLabel>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground"
                      onClick={() => void handleDetectModels()}
                      disabled={detectState.kind === "detecting"}
                    >
                      {detectState.kind === "detecting" ? <Spinner /> : <Search />}
                      {t("settings.localLlm.detectModels")}
                    </Button>
                  </div>
                  <Input
                    id="local-llm-model"
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => {
                      field.handleChange(e.target.value)
                      if (detectState.kind !== "idle" && detectState.kind !== "detecting") {
                        setDetectState({ kind: "idle" })
                      }
                    }}
                    placeholder={DEFAULT_LOCAL_LLM_SETTINGS.model}
                    aria-invalid={invalid}
                    autoComplete="off"
                  />
                  {invalid && <FieldError errors={field.state.meta.errors} />}

                  {detectState.kind === "found-one" && (
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <CheckCircle2 className="size-3 shrink-0" />
                      {t("settings.localLlm.detectedOne", { model: detectState.model })}
                    </p>
                  )}
                  {detectState.kind === "found-none" && (
                    <p className="text-[11px] text-muted-foreground">
                      {t("settings.localLlm.detectedNone")}
                    </p>
                  )}
                  {detectState.kind === "error" && (
                    <p className="flex items-center gap-1.5 text-[11px] text-destructive">
                      <XCircle className="size-3 shrink-0" />
                      {detectState.message}
                    </p>
                  )}
                  {detectState.kind === "found-many" && (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-[11px] text-muted-foreground">
                        {t("settings.localLlm.detectedMany")}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {detectState.models.map((model) => (
                          <Button
                            key={model}
                            type="button"
                            variant="outline"
                            size="xs"
                            className="font-mono"
                            onClick={() => pickDetectedModel(model)}
                          >
                            {model}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </Field>
              )
            }}
          />
        </FieldGroup>

        <div className="flex items-center justify-between gap-2 pt-2">
          <div className="flex items-center gap-2">
            <Button type="submit" form="local-llm-form">
              {t("common.save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleTestConnection()}
              disabled={testState.kind === "testing"}
            >
              {testState.kind === "testing" && <Spinner />}
              {t("settings.localLlm.testConnection")}
            </Button>
          </div>
        </div>

        {testState.kind === "result" && (
          <p
            className={`flex items-start gap-1.5 text-xs ${
              testState.ok ? "text-muted-foreground" : "text-destructive"
            }`}
          >
            {testState.ok ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 size-3.5 shrink-0" />
            )}
            {testState.message}
          </p>
        )}
      </form>
    </SettingsGroup>
  )
}
