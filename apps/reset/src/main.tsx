import React from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Routes, Route } from "react-router-dom"
import { RequestForm } from "./RequestForm"
import { SubmitForm } from "./SubmitForm"
import "./index.css"

const rootEl = document.getElementById("root")
if (!rootEl) {
  throw new Error("apps/reset: #root not found")
}

// Two-route SPA per spec §C:
//   /reset/         → RequestForm (email entry)
//   /reset/:token   → SubmitForm  (new password entry)
//
// Both share the same Worker + Vite bundle; client-side routing picks the
// right form. Reset links from the auth-worker include `?token=<t>&username=<u>`
// in the URL; we accept either path-param or query-param for the token to be
// permissive (the current auth-worker uses query params).
createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter basename="/reset">
      <Routes>
        <Route path="/" element={<RequestForm />} />
        <Route path="/:token" element={<SubmitForm />} />
        {/* Fallback to the request form for any unknown sub-path. */}
        <Route path="*" element={<RequestForm />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
