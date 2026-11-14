import { defineConfig, devices } from "@playwright/test"
import base from "./playwright.config.web"
export default defineConfig(base, {
  testMatch: "**/auth/google-login.spec.ts",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
})
