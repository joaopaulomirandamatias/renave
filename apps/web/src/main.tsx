import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@seu-renave/ui/styles.css";
import "./styles.css";
import { App } from "./App.js";
import { loadWebFeatures } from "./config.js";

const features = loadWebFeatures(import.meta.env);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App stockEntryOperationsEnabled={features.stockEntryOperationsEnabled} />
  </StrictMode>,
);
