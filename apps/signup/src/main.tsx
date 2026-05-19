import React from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { ThemeProvider } from "@aquilla/ui"
import { App } from "./App"
import "./index.css"

const rootEl = document.getElementById("root")
if (!rootEl) {
  throw new Error("apps/signup: #root not found")
}

createRoot(rootEl).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter basename="/signup">
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
)
