// The user's ElevenLabs API key (AQU-2299): bring-your-own-key, kept on this
// device for this user only (owner-scoped localStorage via user-api-keys).
// Never part of a project record, never in ProjectTtsSettings, never synced —
// so it cannot leak to collaborators through the settings blob the way a
// project-level key could. Never log it.

import { getUserApiKey, setUserApiKey, useUserApiKey } from "@/lib/store/user-api-keys"

export function getElevenLabsKey(): string | undefined {
  return getUserApiKey("elevenlabs")
}

export function setElevenLabsKey(value: string | undefined): void {
  setUserApiKey("elevenlabs", value)
}

/** Live key for this user on this device; re-renders on connect/disconnect anywhere. */
export function useElevenLabsKey(): string | undefined {
  return useUserApiKey("elevenlabs")
}
