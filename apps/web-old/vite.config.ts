import { defineConfig } from "vite";

const enableHmr = process.env.PI_WEB_VITE_HMR === "true";
const allowedHosts = (process.env.PI_WEB_VITE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

// This app often points at, and edits, the same workspace that Vite is serving.
// Disable browser HMR/reload by default so an in-browser agent run is not killed
// when file edits touch the web app or shared packages. Opt back in with:
// PI_WEB_VITE_HMR=true bun run dev:web
export default defineConfig({
  server: {
    hmr: enableHmr ? undefined : false,
    allowedHosts,
  },
});
