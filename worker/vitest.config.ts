import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import clerkKey from "./test/fixtures/clerk-test-key.json" with { type: "json" };

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
            FRONTEND_URL: "http://localhost:5173",
            REDIRECT_BASE_URL: "https://share.example.com",
            PLATFORM_REDIRECT_HOST: "share.example.com",
            STORAGE_UPLOAD_SECRET: "test-upload-secret",
            CLERK_SECRET_KEY: "sk_test_dummy",
            CLERK_JWKS_JSON: JSON.stringify(clerkKey.jwks),
            SERVICE_API_KEYS: "champ-workspace:svc-test-key",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
