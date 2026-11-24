import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backend = "http://127.0.0.1:8765";

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", assetsDir: "assets", assetsInlineLimit: 0 },
  server: { proxy: { "/api": backend, "/photos": backend, "/login": backend } },
});
