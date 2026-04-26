import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppProviders } from "./providers/AppProviders";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root missing from index.html");
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>,
);
