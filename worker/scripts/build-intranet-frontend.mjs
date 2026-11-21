// Build the intranet SPA (VITE_APP_MODE=intranet) into ../frontend/dist-intranet, the assets directory of the
// `intranet` wrangler environment. Cross-platform replacement for `VITE_APP_MODE=intranet vite build`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../../frontend/", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args, env = {}) => {
  const r = spawnSync(npm, args, { cwd: frontend, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
if (!process.argv.includes("--no-install")) run(["ci", "--no-audit", "--no-fund"]);
run(["run", "build", "--", "--outDir", "dist-intranet", "--emptyOutDir"], { VITE_APP_MODE: "intranet", VITE_API_URL: "" });
