import React from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { ThemeProvider } from "@aquilla/ui"
import { App } from "./App"
import "./index.css"

const rootEl = document.getElementById("root")
if (!rootEl) {
  throw new Error("apps/login: #root not found")
}

// AD-11 base-path discipline: BrowserRouter basename mirrors the Vite
// `base` config so internal navigation stays inside /login/*.
//
// ThemeProvider shares localStorage["codex-theme"] with every other app
// on aquilla.app; the inline pre-paint script in index.html applies the
// `dark` class before this code runs so we never flash a wrong-mode frame.
createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter basename="/login">
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
)
