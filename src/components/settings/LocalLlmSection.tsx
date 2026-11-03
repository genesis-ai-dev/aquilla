import { useState } from "react"
import { CheckCircle2, Search, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { CommitTextInput } from "@/components/settings/CommitInput"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { SettingsGroup } from "@/components/ui/page"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { SaveStatus, useSaveTracker } from "@/lib/settings/save-status"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import {
  DEFAULT_LOCAL_LLM_SETTINGS,
  setLocalLlmSettings,
  useLocalLlmSettings,
  type LocalLlmSettings,
} from "@/lib/offline/llm-settings"
import { listLocalLlmModels, testLocalLlmConnection } from "@/lib/offline/local-llm-client"

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
 *
 * AQU-2262: the fields save as you change them (when you leave one, or pause
 * typing), and a detected model saves when it is filled in. There is no Save
 * button; Test connection tries what is saved.
 */
export function LocalLlmSection() {
  const { t } = useI18n()
  const settings = useLocalLlmSettings()
  const track = useSaveTracker()
  const [testState, setTestState] = useState<TestState>({ kind: "idle" })
  const [detectState, setDetectState] = useState<DetectState>({ kind: "idle" })

  if (!isTauriRuntime()) return null

  function save(field: keyof LocalLlmSettings, value: string) {
    void track(`localLlm.${field}`, async () => {
      setLocalLlmSettings({ ...settings, [field]: value })
      setTestState({ kind: "idle" })
      return { kind: "saved" }
    })
  }

  async function handleTestConnection() {
    setTestState({ kind: "testing" })
    const result = await testLocalLlmConnection(settings)
    setTestState({ kind: "result", ok: result.ok, message: result.message })
  }

  async function handleDetectModels() {
    setDetectState({ kind: "detecting" })
    try {
      const models = await listLocalLlmModels(settings.endpoint)
      if (models.length === 0) {
        setDetectState({ kind: "found-none" })
      } else if (models.length === 1) {
        save("model", models[0])
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
    save("model", model)
    setDetectState({ kind: "found-one", model })
  }

  return (
    <SettingsGroup label={t("settings.localLlm.groupLabel")}>
      <div className="flex flex-col gap-4 px-5 py-4">
        <p className="text-xs text-muted-foreground">{t("settings.localLlm.description")}</p>

        <FieldGroup>
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="local-llm-endpoint">
                {t("projectSettings.advancedLlm.endpointLabel")}
              </FieldLabel>
              <SaveStatus id="localLlm.endpoint" />
            </div>
            {/* An empty field is never saved: the last endpoint stays. */}
            <CommitTextInput
              id="local-llm-endpoint"
              value={settings.endpoint}
              required
              onCommit={(next) => save("endpoint", next)}
              placeholder={DEFAULT_LOCAL_LLM_SETTINGS.endpoint}
              autoComplete="off"
            />
          </Field>

          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="local-llm-model">
                {t("projectSettings.advancedLlm.modelLabel")}
              </FieldLabel>
              <span className="flex items-center gap-2">
                <SaveStatus id="localLlm.model" />
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
              </span>
            </div>
            <CommitTextInput
              id="local-llm-model"
              value={settings.model}
              required
              onCommit={(next) => save("model", next)}
              // A model typed by hand replaces what detection said.
              onInput={() => {
                if (detectState.kind !== "idle" && detectState.kind !== "detecting") {
                  setDetectState({ kind: "idle" })
                }
              }}
              placeholder={DEFAULT_LOCAL_LLM_SETTINGS.model}
              autoComplete="off"
            />

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
        </FieldGroup>

        <div className="flex items-center justify-between gap-2 pt-2">
          <div className="flex items-center gap-2">
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
      </div>
    </SettingsGroup>
  )
}
