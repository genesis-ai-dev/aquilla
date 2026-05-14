import React from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { App } from "./App"
import "./index.css"

const rootEl = document.getElementById("root")
if (!rootEl) {
  throw new Error("apps/login: #root not found")
}

// AD-11 base-path discipline: BrowserRouter basename mirrors the Vite
// `base` config so internal navigation stays inside /login/*.
createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter basename="/login">
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
