/**
 * Project settings save the moment they change. (AQU-2262)
 *
 * Every control on the page calls one of these instead of filling a draft for
 * a Save bar:
 *
 * - `shared`: the team's settings, through the shared settings patch. The
 *   patch is told what the person saw, so a change made over someone else's
 *   newer change to the same setting is refused and theirs is kept (the
 *   setting says so). A change to one field of the drafting settings is merged
 *   into the server's copy of them. The change is one Undo step,
 *   "Change: <setting>".
 * - `device`: a setting kept only on this device (Audio loading, Git
 *   auto-sync, Health). Saved in this browser's copy of the project; an Undo
 *   step only this browser can take back.
 * - `secret`: the project's AI keys. Saved on this device only, and never
 *   recorded: a step is saved to the server, a key never leaves the browser.
 * - `name`: the project's name, through the rename endpoint.
 *
 * Typing fields call these with `CommitInfo` (useCommitOnPause): a pause
 * writes without a step, leaving the field ends the change and records it as
 * one step from where it started.
 *
 * Each returns how it went, which the page's save status shows beside the
 * setting.
 */
import { useCallback, useRef } from "react"
import { recordStep } from "@/lib/history/history"
import { thisBrowser } from "@/lib/history/settings-steps"
import type { SettingsChange } from "@/lib/history/edit-steps"
import { useSaveTracker, type SaveResult } from "@/lib/settings/save-status"
import type { CommitInfo } from "@/lib/settings/useCommitOnPause"
import { getProject, patchProject, updateProject } from "@/lib/store/project-index"
import { renameProject } from "@/lib/sync/cloud-projects"
import { settingsEditorName, type ProjectWideSettings } from "@/lib/sync/project-settings"
import type { PatchOptions, PatchOutcome } from "@/hooks/useProjectSettings"
import { readSettingAt } from "@/lib/settings/setting-at"
import { UserError } from "@/lib/errors/user-error"
import { resolveRoleName, ROLE } from "@/lib/frontier/roles"
import { withDeviceSetting, type DeviceSettingKey } from "./useSettingsStepKinds"
import { sharedSettingLabel } from "./setting-labels"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

export interface SharedChange {
  key: string
  /** One field of an object setting (the drafting settings). */
  field?: string
  value: unknown
}

export interface SettingsCommitOptions {
  projectId: string | null
  /** The project as this page shows it: what this browser's copy starts
   *  from when it has none yet (a project opened straight at its settings). */
  project: ProjectRecord | null
  /** Whose history the steps go in. */
  username: string
  isCloudProject: boolean
  /** The shared settings as this page shows them. */
  settings: ProjectWideSettings
  patch: (partial: ProjectWideSettings, opts?: PatchOptions) => Promise<PatchOutcome>
  getJwt: () => string | null
  t: TFunction
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function useSettingsCommit(options: SettingsCommitOptions) {
  const track = useSaveTracker()
  const ref = useRef(options)
  ref.current = options
  // A typing change's values as they were when it started (by status id):
  // what its one Undo step puts back, however many pauses wrote meanwhile.
  // Raw, not as shown: a count that followed the organization shows the
  // organization's number, and Undo must put "Organization default" back.
  const startedAt = useRef(new Map<string, unknown[]>())
  const startOf = (id: string, now: unknown[], typed: CommitInfo<unknown> | undefined): unknown[] => {
    if (!typed) return now
    const kept = startedAt.current.get(id)
    if (typed.final) startedAt.current.delete(id)
    else if (!kept) startedAt.current.set(id, now)
    return kept ?? now
  }

  // This browser's copy of the project. A browser that has never opened the
  // project (settings opened straight from a link) has none yet; a change
  // starts it from the page's own copy, as the Save bar did.
  const localRecord = async (projectId: string): Promise<ProjectRecord | null> =>
    (await getProject(projectId)) ?? ref.current.project ?? null
  const patchLocal = async (projectId: string, update: (p: ProjectRecord) => ProjectRecord) => {
    const patched = await patchProject(projectId, update)
    if (patched) return patched
    const base = ref.current.project
    if (!base) return undefined
    const next = update(base)
    await updateProject(next)
    return next
  }

  const scope = () => {
    const { projectId, username } = ref.current
    return projectId ? { projectId, username } : undefined
  }
  const named = (labelKey: MessageKey) => ({
    labelKey: "editor.history.stepChangeSetting",
    labelParams: { setting: ref.current.t(labelKey), settingKey: labelKey },
    lane: null,
  })
  const roleLine = () => {
    const { t } = ref.current
    return t("projectSettings.permission.onlyRoleCanModify", { role: resolveRoleName(t, ROLE.MAINTAINER, { plural: true }) })
  }

  /** How a shared write went, for the save status. */
  const sharedResult = (out: PatchOutcome): SaveResult => {
    const { t, isCloudProject } = ref.current
    switch (out.kind) {
      case "ok":
        return { kind: "saved" }
      case "conflict":
        return { kind: "theirs", name: settingsEditorName(out.latest.updatedBy) ?? null }
      case "blocked":
        // A project that lives only in this browser has no server to write to:
        // its settings were saved here, which is all there is.
        if (!isCloudProject && out.reason === "role") return { kind: "saved" }
        return { kind: "failed", message: out.reason === "offline" ? t("settings.save.offline") : roleLine() }
      case "error":
        return { kind: "failed", message: out.message || t("settings.save.failed") }
    }
  }
  const landed = (out: PatchOutcome) => out.kind === "ok" || (!ref.current.isCloudProject && out.kind === "blocked" && out.reason === "role")

  /**
   * Write shared settings and record the change. `typed` is a typing field's
   * change: a pause writes only, leaving the field records one step from
   * where it started (and writes only if a pause has not already).
   */
  const writeShared = async (
    id: string,
    labelKey: MessageKey,
    changes: SharedChange[],
    typed?: CommitInfo<unknown>,
  ): Promise<{ result: SaveResult; outcome: PatchOutcome | null }> => {
    const { settings, patch } = ref.current
    const shown = changes.map((c) => readSettingAt(settings, c.key, c.field))
    const befores = startOf(id, shown, typed)
    const record = !typed || typed.final
    const steps: SettingsChange[] = changes
      .map((c, i) => ({
        key: c.key,
        ...(c.field !== undefined ? { field: c.field } : {}),
        before: befores[i],
        after: c.value,
      }))
      .filter((c) => !same(c.before, c.after))
    const step = (pending?: Promise<boolean>) => {
      if (!record || steps.length === 0) return
      recordStep({ kind: "settings.project", data: { changes: steps }, ...named(labelKey) }, scope(), pending ? { pending } : undefined)
    }
    if (changes.every((c, i) => same(shown[i], c.value))) {
      // Nothing new to write — a pause already saved it; the change only
      // needs its step now.
      step()
      return { result: record && steps.length > 0 ? { kind: "saved" } : { kind: "none" }, outcome: null }
    }
    const partial: Record<string, unknown> = {}
    const mergeKeys = new Set<string>()
    for (const c of changes) {
      if (c.field !== undefined) {
        partial[c.key] = { ...((partial[c.key] as Record<string, unknown> | undefined) ?? {}), [c.field]: c.value }
        mergeKeys.add(c.key)
      } else {
        // undefined clears the project's own value (back to the organization's).
        partial[c.key] = c.value
      }
    }
    const pending = patch(partial as ProjectWideSettings, {
      expect: changes.map((c, i) => ({ key: c.key, ...(c.field !== undefined ? { field: c.field } : {}), value: shown[i] })),
      ...(mergeKeys.size > 0 ? { mergeKeys: [...mergeKeys] } : {}),
    })
    step(pending.then(landed, () => false))
    const outcome = await pending
    return { result: sharedResult(outcome), outcome }
  }

  /** Change the team's settings now. `id` is where its status shows. */
  const shared = useCallback(
    (id: string, labelKey: MessageKey, changes: SharedChange[], typed?: CommitInfo<unknown>) =>
      track(id, async () => (await writeShared(id, labelKey, changes, typed)).result),
    // writeShared reads everything through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [track],
  )

  /**
   * A patch for a section that writes the shared settings itself (the
   * visibility floors, Autopilot…): recorded as one step and shown beside
   * the setting, its outcome handed back. `ownErrors`: what the section
   * already says itself when a write did not land — "failures" (a refusal or
   * an error; who won a conflict still shows here) or "all".
   */
  const recordedPatch = useCallback(
    (opts: { labelKey?: MessageKey; id?: string; ownErrors?: "failures" | "all" } = {}) =>
      async (partial: ProjectWideSettings): Promise<PatchOutcome> => {
        const keys = Object.keys(partial)
        const id = opts.id ?? keys[0] ?? "settings"
        const labelKey = opts.labelKey ?? sharedSettingLabel(keys[0] ?? "")
        let outcome: PatchOutcome = { kind: "ok" }
        await track(id, async () => {
          const out = await writeShared(id, labelKey, keys.map((key) => ({ key, value: (partial as Record<string, unknown>)[key] })))
          if (out.outcome) outcome = out.outcome
          if (opts.ownErrors === "all" && out.result.kind !== "saved") return { kind: "none" }
          if (opts.ownErrors === "failures" && out.result.kind === "failed") return { kind: "none" }
          return out.result
        })
        return outcome
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [track],
  )

  /** Change a setting kept only on this device. */
  const device = useCallback(
    (id: string, labelKey: MessageKey, key: DeviceSettingKey, value: unknown, typed?: CommitInfo<unknown>) =>
      track(id, async () => {
        const projectId = ref.current.projectId
        if (!projectId) return { kind: "none" }
        const record = await localRecord(projectId)
        if (!record) return { kind: "failed", message: ref.current.t("settings.save.failed") }
        const now = (record as unknown as Record<string, unknown>)[key] ?? null
        const [before] = startOf(id, [now], typed)
        const record_ = !typed || typed.final
        const step = (pending?: Promise<boolean>) => {
          if (!record_ || same(before, value)) return
          recordStep(
            { kind: "settings.device", data: { browser: thisBrowser(), key, before, after: value ?? null }, ...named(labelKey) },
            scope(),
            pending ? { pending } : undefined,
          )
        }
        if (same(now, value)) {
          step()
          return record_ && !same(before, value) ? { kind: "saved" } : { kind: "none" }
        }
        const pending = patchLocal(projectId, (p) => withDeviceSetting(p, key, value)).then(Boolean, () => false)
        step(pending)
        return (await pending) ? { kind: "saved" } : { kind: "failed", message: ref.current.t("settings.save.failed") }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [track],
  )

  /** Save an AI key on this device. Never an Undo step. */
  const secret = useCallback(
    (id: string, update: (p: ProjectRecord) => ProjectRecord) =>
      track(id, async () => {
        const projectId = ref.current.projectId
        if (!projectId) return { kind: "none" }
        const next = await patchLocal(projectId, update)
        return next ? { kind: "saved" } : { kind: "failed", message: ref.current.t("settings.save.failed") }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [track],
  )

  /** Rename the project (a typing field). */
  const name = useCallback(
    (next: string, info: CommitInfo<string>) =>
      track("name", async () => {
        const { projectId, isCloudProject, getJwt, t } = ref.current
        if (!projectId) return { kind: "none" }
        const record = await localRecord(projectId)
        if (!record) return { kind: "failed", message: t("settings.save.failed") }
        const step = (pending?: Promise<boolean>) => {
          if (!info.final || info.from === next) return
          recordStep(
            { kind: "settings.projectName", data: { before: info.from, after: next }, ...named("projectSettings.info.titleLabel") },
            scope(),
            pending ? { pending } : undefined,
          )
        }
        if (record.name === next) {
          step()
          return info.final && info.from !== next ? { kind: "saved" } : { kind: "none" }
        }
        const write = (async (): Promise<SaveResult> => {
          if (isCloudProject) {
            const jwt = getJwt()
            if (!jwt) return { kind: "failed", message: t("projectSettings.save.signedOutRenameError") }
            try {
              await renameProject(jwt, projectId, next)
            } catch (err) {
              if (err instanceof UserError && err.status === 403) return { kind: "failed", message: roleLine() }
              return { kind: "failed", message: err instanceof Error ? err.message : t("projectSettings.save.renameFailedGeneric") }
            }
          }
          await patchLocal(projectId, (p) => ({ ...p, name: next }))
          return { kind: "saved" }
        })()
        step(write.then((r) => r.kind === "saved", () => false))
        return write
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [track],
  )

  return { shared, recordedPatch, device, secret, name }
}
