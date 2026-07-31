import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4096,
    strictPort: true,
    allowedHosts: ["mac-mini.taile07e4.ts.net", ".ts.net"],
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:4097",
        ws: true,
        rewrite: () => "/ws",
      },
    },
  },
});

