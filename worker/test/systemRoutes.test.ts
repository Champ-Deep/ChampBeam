/**
 * /api/v1/system. Ports the two route cases of backend/tests/test_maxmind_usage.py
 * (the service-level cases live with the maxmindUsage service tests).
 */
import { describe, expect, it } from "vitest";
import { api, authedUser, env } from "./helpers";
import { getDb } from "../src/db/client";
import { recordLookup } from "../src/services/maxmindUsage";
import { setSettings } from "./serveSeed";

describe("system endpoints (test_maxmind_usage.py)", () => {
  it("need auth and report", async () => {
    expect((await api("/api/v1/system/maxmind")).status).toBe(401);
    expect((await api("/api/v1/system/status")).status).toBe(401);

    // a deployment that really does call MaxMind, so the balance is graded
    setSettings({ maxmindAccountId: "123456", maxmindLicenseKey: "test-key", maxmindWsConfigured: true });
    const { headers } = await authedUser();
    await recordLookup(getDb(env.DB), { queriesRemaining: 42, ok: true });

    const r = await api("/api/v1/system/maxmind", { headers });
    expect(r.status).toBe(200);
    expect((await r.json<any>()).queries_remaining).toBe(42);

    const s = await api("/api/v1/system/status", { headers });
    expect(s.status).toBe(200);
    const body = await s.json<any>();
    expect(body.checks.database.status).toBe("ok");
    // 42 credits is under the critical threshold -> the monitor must not read "ok"
    expect(body.checks.maxmind.status).toBe("critical");
    expect(body.checks.maxmind).toMatchObject({ configured: true, queries_remaining: 42 });
    expect(body.ok).toBe(false);

    expect((await api("/api/v1/system/maxmind?days=0", { headers })).status).toBe(422);
    expect((await api("/api/v1/system/maxmind?days=7", { headers })).status).toBe(200);
  });

  it("status reports off when the service is not configured", async () => {
    setSettings({ maxmindAccountId: "", maxmindLicenseKey: "", maxmindWsConfigured: false });
    const { headers } = await authedUser();
    const r = await api("/api/v1/system/status", { headers });
    expect(r.status).toBe(200);
    const body = await r.json<any>();
    expect(body.checks.maxmind.status).toBe("off");
    expect(body.checks.maxmind.configured).toBe(false);
    expect(body.ok).toBe(true);
  });
});
