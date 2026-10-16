// AQU-1978: the cast roster's language list comes from the lane ROWS.
//
// It read the retired `targetLanes` / `archivedLanes` settings keys, which are
// absent on a project made since AQU-1594 — so the roster offered only the open
// lane's language — and which hold TAGS, so a lane tagged with its own id was
// offered as the language "a3f09c1e".

import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { ProjectTtsApi } from "@/hooks/useProjectTts"

const panelProps = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock("../VoiceLibraryPanel", () => ({
  VoiceLibraryPanel: (props: Record<string, unknown>) => {
    panelProps.push(props)
    return null
  },
}))

import { VoiceSidebar } from "./VoiceSidebar"

const tts = { settings: {}, saveTts: vi.fn(), castStats: new Map() } as unknown as ProjectTtsApi

describe("VoiceSidebar (AQU-1978)", () => {
  it("offers the live target lanes' languages, in switcher order, from the rows", () => {
    const project = {
      id: "p1",
      // What a new project still carries at the project level: nothing.
      targetLanguage: "",
      lanes: [
        { id: "src00001", role: "source", language: "English", name: null, langCode: null, legacyTag: null, position: 0, archivedAt: null },
        { id: "a3f09c1e", role: "target", language: "Portuguese", name: null, langCode: null, legacyTag: "a3f09c1e", position: 1, archivedAt: null },
        { id: "spa00001", role: "target", language: "Spanish", name: null, langCode: null, legacyTag: "Spanish", position: 0, archivedAt: null },
        { id: "frc00001", role: "target", language: "French", name: null, langCode: null, legacyTag: "French", position: 2, archivedAt: "2026-10-01" },
      ],
    } as unknown as ProjectRecord
    render(
      <VoiceSidebar
        cells={[]}
        project={project}
        projectId="p1"
        tts={tts}
        session={null}
        username="sam"
        targetLanguage="Spanish"
      />,
    )
    const props = panelProps.at(-1)!
    expect(props.targetLanguage).toBe("Spanish")
    expect(props.targetLanes).toEqual(["Spanish", "Portuguese"])
    expect(props.archivedLanes).toBeUndefined()
  })
})
