// Bindings visible to tests via `import { env } from "cloudflare:test"`.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    FILES: R2Bucket;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

/** Vite `?raw` imports (test fixtures read SQL and text files). */
declare module "*?raw" {
  const text: string;
  export default text;
}
