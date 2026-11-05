/**
 * Port of backend/app/api/v1/internal_provisioning.py — mounted at
 * /api/v1/internal/provisioning.
 *
 * Internal API for the host-side BYOD provisioner
 * (deploy/provisioner/champbeam-provisioner.sh): it polls for domains awaiting
 * a vhost + certificate, runs the provisioning script, and reports back.
 *
 * Auth is a shared secret (X-Provisioner-Token) compared in constant time; the
 * routes 404 when the token is unconfigured so the surface simply doesn't
 * exist on deployments that don't use the self-hosted path.
 *
 * Abuse gate: only domains a user registered (hostname-validated, platform
 * hosts rejected at create) that ALSO passed the DNS pre-check ever appear in
 * the work list, and each domain gets at most MAX_PROVISION_ATTEMPTS
 * certificate attempts — the daemon can never be steered into issuing certs
 * for arbitrary hostnames.
 */
import { Hono } from "hono";
import { and, eq, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import {
  DOMAIN_STATUS_ACTIVE,
  DOMAIN_STATUS_FAILED,
  DOMAIN_STATUS_PENDING_SSL,
  domains,
} from "../db/schema";
import { httpError } from "../lib/errors";
import { parseJson } from "../lib/validate";
import { timingSafeEqual } from "../lib/crypto";
import { nowIso } from "../lib/time";
import { MAX_PROVISION_ATTEMPTS, verifyReachable } from "../services/domainProvisioning";

export const router = new Hono<AppEnv>({ strict: false });

function requireProvisionerToken(c: Ctx): void {
  const configured = c.var.settings.provisionerToken;
  if (!configured) httpError(404, "Not found");
  const presented = c.req.header("x-provisioner-token");
  if (!presented || !timingSafeEqual(presented, configured)) {
    httpError(401, "Invalid provisioner token");
  }
}

const ProvisionResult = z.object({
  ok: z.boolean(),
  error: z.string().nullish(),
});

/** Lenient UUID parse (like Python's UUID()): canonical lowercase, or null. */
function canonicalUuid(v: string): string | null {
  let s = v.trim().toLowerCase();
  if (s.startsWith("urn:uuid:")) s = s.slice(9);
  s = s.replace(/^\{|\}$/g, "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Domains awaiting a vhost + certificate on the host. */
router.get("/domains", async (c) => {
  requireProvisionerToken(c);
  const rows = await c.var.db
    .select()
    .from(domains)
    .where(
      and(
        eq(domains.status, DOMAIN_STATUS_PENDING_SSL),
        isNull(domains.cfCustomHostnameId),
        lt(domains.provisionAttempts, MAX_PROVISION_ATTEMPTS),
      ),
    )
    .all();
  return c.json(rows.map((d) => ({ id: d.id, hostname: d.hostname, attempts: d.provisionAttempts ?? 0 })));
});

router.post("/domains/:domain_id/result", async (c) => {
  requireProvisionerToken(c);
  const data = await parseJson(c, ProvisionResult);
  const uid = canonicalUuid(c.req.param("domain_id") ?? "");
  if (!uid) httpError(400, "Invalid domain ID");
  const db = c.var.db;
  const domain = await db.select().from(domains).where(eq(domains.id, uid)).get();
  if (!domain) httpError(404, "Domain not found");

  domain.provisionAttempts = (domain.provisionAttempts ?? 0) + 1;
  domain.lastCheckedAt = nowIso();

  if (data.ok && (await verifyReachable(domain.hostname))) {
    domain.status = DOMAIN_STATUS_ACTIVE;
    domain.sslStatus = "active";
    if (domain.verifiedAt == null) domain.verifiedAt = nowIso();
    domain.verificationErrors = null;
    console.info(`domain ${domain.hostname} provisioned and live`);
  } else if (data.ok) {
    // Cert issued but not reachable yet (e.g. propagation); stay pending and
    // let the provision loop's re-verify flip it, up to the attempt cap.
    domain.verificationErrors = {
      message: "Certificate issued; waiting for the hostname to become reachable.",
    };
    console.info(`domain ${domain.hostname} provisioned but not yet reachable`);
  } else {
    domain.verificationErrors = {
      message: `Certificate provisioning failed: ${data.error || "unknown error"}`,
    };
    console.warn(
      `domain ${domain.hostname} provisioning failed (attempt ${domain.provisionAttempts}): ${data.error}`,
    );
  }

  if (domain.status === DOMAIN_STATUS_PENDING_SSL && domain.provisionAttempts >= MAX_PROVISION_ATTEMPTS) {
    domain.status = DOMAIN_STATUS_FAILED;
  }

  await db
    .update(domains)
    .set({
      provisionAttempts: domain.provisionAttempts,
      lastCheckedAt: domain.lastCheckedAt,
      status: domain.status,
      sslStatus: domain.sslStatus,
      verifiedAt: domain.verifiedAt,
      verificationErrors: domain.verificationErrors ?? null,
    })
    .where(eq(domains.id, domain.id));

  return c.json({ status: domain.status, attempts: domain.provisionAttempts });
});
