// @ts-check
import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://localmax.net",
  output: "server",
  adapter: cloudflare({
    platformProxy: { enabled: true },
    imageService: "passthrough",
  }),
  // The site has no accounts and no server-side session state — every page is a pure
  // function of the URL and the API response. Declaring an in-memory driver stops the
  // adapter provisioning a KV namespace that would never hold anything.
  session: { driver: "memory" },
  build: {
    // Every chart is server-rendered SVG, so there is almost no client bundle to split.
    inlineStylesheets: "always",
  },
  vite: {
    build: {
      // Release gate: the whole site's client JS stays under 30 kB gzipped.
      chunkSizeWarningLimit: 40,
    },
  },
  devToolbar: { enabled: false },
});
