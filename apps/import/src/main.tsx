import { createRoot } from "react-dom/client"
import { ThemeProvider } from "@aquilla/ui"
import "./index.css"
import { App } from "./App"

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
)
