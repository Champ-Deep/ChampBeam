// The intranet suite: same Worker, INTRANET_MODE=true (only the intranet API, Better Auth, health and the SPA).
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: "test",
            DEBUG: "true",
            INTRANET_MODE: "true",
            FRONTEND_URL: "https://share.example.com",
            REDIRECT_BASE_URL: "https://share.example.com",
            PLATFORM_REDIRECT_HOST: "share.example.com",
            SHARE_ORIGIN_HOSTS: "",
            STORAGE_UPLOAD_SECRET: "test-upload-secret",
            BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
            BETTER_AUTH_URL: "https://share.example.com",
            GOOGLE_CLIENT_ID: "",
            GOOGLE_CLIENT_SECRET: "",
            CLERK_PUBLISHABLE_KEY: "",
            SERVICE_API_KEYS: "",
            R2_ACCOUNT_ID: "",
            R2_ACCESS_KEY_ID: "",
            R2_SECRET_ACCESS_KEY: "",
            CLAMD_HOST: "",
            CLEF_URL: "",
            JEV_API_KEY: "",
            REVIEW_AGENT_ALLOW_MOCK: "true",
            INTRANET_ORG_IDS: "",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      include: ["test/intranet/**/*.test.ts"],
    },
  };
});
