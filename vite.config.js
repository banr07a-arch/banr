import { defineConfig } from "vite";

export default defineConfig({
  build: { rollupOptions: { input: { patient: "index.html", provider: "provider/index.html", admin: "admin/index.html" } } },
});
