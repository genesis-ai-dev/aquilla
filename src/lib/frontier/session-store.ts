import { openDB } from "idb";
import type { FrontierSession } from "./types";

const DB = "frontier";
const STORE = "session";
const KEY = "current";

async function db() {
  return openDB(DB, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    },
  });
}

export async function saveSession(s: FrontierSession): Promise<void> {
  const d = await db();
  await d.put(STORE, s, KEY);
}

export async function loadSession(): Promise<FrontierSession | null> {
  const d = await db();
  const s = await d.get(STORE, KEY);
  return (s as FrontierSession | undefined) ?? null;
}

export async function clearSession(): Promise<void> {
  const d = await db();
  await d.delete(STORE, KEY);
}
