import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@maxhub/max-ui/dist/styles.css";
import "@fontsource/unbounded/cyrillic-900.css";
import "@fontsource/unbounded/latin-900.css";
import "@fontsource/alumni-sans/cyrillic-800.css";
import "@fontsource/alumni-sans/latin-800.css";
import "@fontsource/alumni-sans/cyrillic-900.css";
import "@fontsource/alumni-sans/latin-900.css";
import "@fontsource/onest/cyrillic-500.css";
import "@fontsource/onest/latin-500.css";
import "@fontsource/onest/cyrillic-700.css";
import "@fontsource/onest/latin-700.css";
import "./app.css";
import { App } from "./App.js";

const root = document.getElementById("root");
if (root === null) throw new Error("#root is missing from index.html");
createRoot(root).render(<StrictMode><App /></StrictMode>);
