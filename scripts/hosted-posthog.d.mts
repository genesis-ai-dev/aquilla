export const hostedPosthog: Readonly<{
  projectId: number
  projectToken: string
  ingestHost: string
}>
export function hostedPosthogEnv(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined> & {
  VITE_POSTHOG_KEY: string
  VITE_POSTHOG_HOST: string
}
