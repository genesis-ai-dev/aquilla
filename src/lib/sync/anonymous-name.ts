// Friendly, deterministic display name for unauthenticated peers.
//
// Yjs gives each connected client an ephemeral numeric `clientID`. Without a
// real username on the awareness state, the presence UI would otherwise fall
// back to that bare number. We hash the clientID into a stable adjective+noun
// pair so each anonymous peer has a recognizable handle for the session
// ("Drifting Comet", "Quiet River") and a color from the existing palette.
//
// Word list intentionally avoids culture-bound referents (animals, mythological
// figures, foods). Natural phenomena — celestial, atmospheric, landscape —
// are universally recognizable.

const ADJECTIVES = [
  "Drifting", "Wandering", "Quiet", "Bright", "Calm",
  "Soft", "Gentle", "Distant", "Silver", "Golden",
  "Misty", "Hidden", "Flowing", "Open", "Whispering",
  "Rising", "Falling", "Still", "Glowing", "Roaming",
] as const

const NOUNS = [
  "Comet", "Star", "Moon", "Sun", "Planet",
  "Aurora", "Eclipse", "Galaxy", "Nebula", "Meteor",
  "Mountain", "River", "Ocean", "Forest", "Desert",
  "Glacier", "Canyon", "Valley", "Meadow", "Island",
  "Cloud", "Wind", "Rain", "Mist", "Storm",
  "Thunder", "Dawn", "Dusk", "Twilight", "Horizon",
] as const

function hashString(s: string): number {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

export function anonymousNameFor(clientId: string | number): string {
  const id = String(clientId)
  const h = hashString(id)
  const adj = ADJECTIVES[h % ADJECTIVES.length]
  // Multiply-and-shift so adjective and noun aren't perfectly correlated for
  // adjacent clientIDs — keeps small rooms visually varied.
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]
  return `${adj} ${noun}`
}

// Treat these placeholder values as "no real identity yet" — useSync will
// substitute the friendly anonymous name for awareness publishing.
const PLACEHOLDER_USERNAMES = new Set(["", "local", "anonymous"])

export function isPlaceholderUsername(name: string | null | undefined): boolean {
  if (!name) return true
  return PLACEHOLDER_USERNAMES.has(name.trim().toLowerCase())
}

export function displayNameFor(username: string | null | undefined, clientId: string | number): string {
  return isPlaceholderUsername(username) ? anonymousNameFor(clientId) : (username as string)
}
