import { applyD1Migrations, env } from "cloudflare:test";

// Fresh schema for every test file (storage is isolated per file).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
