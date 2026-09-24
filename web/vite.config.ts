import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` keeps the bundle working whatever path the mini app URL points at; the server
// serves it from the same origin as the API, so requests stay relative.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: { port: 5173, strictPort: true },
});
