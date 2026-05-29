import { useCallback, useEffect, useState } from "react";

import type { EditorLens } from "@/components/EditorModeToggle";

const STORAGE_PREFIX = "codex:editorLens:";

const storageKey = (projectId: string): string => `${STORAGE_PREFIX}${projectId}`;

const readLens = (projectId: string): EditorLens => {
  if (typeof window === "undefined") return "text";
  try {
    return window.localStorage.getItem(storageKey(projectId)) === "audio" ? "audio" : "text";
  } catch {
    return "text";
  }
};

export function useEditorLensPreference(
  projectId: string
): [EditorLens, (lens: EditorLens) => void] {
  const [lens, setLensState] = useState<EditorLens>(() => readLens(projectId));

  useEffect(() => {
    setLensState(readLens(projectId));
  }, [projectId]);

  const setLens = useCallback(
    (next: EditorLens) => {
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(storageKey(projectId), next);
        } catch {
          /* ignore persistence failures */
        }
      }
      setLensState(next);
    },
    [projectId]
  );

  return [lens, setLens];
}
