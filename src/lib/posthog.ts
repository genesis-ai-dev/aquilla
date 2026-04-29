import { PostHog } from "posthog-node"

const posthog = new PostHog(import.meta.env.VITE_POSTHOG_KEY as string, {
  host: import.meta.env.VITE_POSTHOG_HOST as string,
  enableExceptionAutocapture: true,
})

export function getAnonymousId(): string {
  const key = "posthog_anonymous_id"
  let id = localStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(key, id)
  }
  return id
}

export default posthog
