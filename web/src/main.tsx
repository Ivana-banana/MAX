import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@maxhub/max-ui/dist/styles.css";
import "@fontsource-variable/tektur/wdth.css";
import "@fontsource/pt-sans/cyrillic-400.css";
import "@fontsource/pt-sans/latin-400.css";
import "@fontsource/pt-sans/cyrillic-700.css";
import "@fontsource/pt-sans/latin-700.css";
import "./app.css";
import { App } from "./App.js";

const root = document.getElementById("root");
if (root === null) throw new Error("#root is missing from index.html");
createRoot(root).render(<StrictMode><App /></StrictMode>);
