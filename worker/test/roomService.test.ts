/** Service-level tests for src/services/room.ts (the service rules exercised by test_rooms.py). */
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { getSettings } from "../src/env";
import { HTTPError } from "../src/lib/errors";
import * as rs from "../src/services/room";
import { createOrg, createUser, env } from "./helpers";

const db = getDb(env.DB);
const settings = getSettings(env as never);

async function expectHttp(fn: () => Promise<unknown>, status: number, detail?: string) {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HTTPError);
    expect((e as HTTPError).status).toBe(status);
    if (detail !== undefined) expect((e as HTTPError).detail).toBe(detail);
    return;
  }
  throw new Error("expected HTTPError");
}

async function makeRoom() {
  const org = await createOrg();
  const user = await createUser();
  const room = await rs.createRoom(db, {
    orgUuid: org.id,
    ownerUserId: user.id,
    title: "Ferrovial Briefing",
    bucket: "infrastructure",
    assetIds: ["asset_deck", "asset_video"],
    personalization: { prepared_for_line: "Prepared for {{company_name}}'s leadership team" },
  });
  return { org, user, room };
}

describe("rooms", () => {
  it("room1: create (draft, slug, collision suffix), get, publish", async () => {
    const { org, room } = await makeRoom();
    expect(room.state).toBe("draft");
    expect(room.slug).toMatch(/^ferrovial-briefing(-[a-z0-9]{6})?$/);
    expect(room.assetIds).toEqual(["asset_deck", "asset_video"]);
    const again = await makeRoom();
    expect(again.room.slug).not.toBe(room.slug);

    const got = await rs.getOrgRoom(db, room.id.toUpperCase().replace(/-/g, ""), org.id);
    expect(got.id).toBe(room.id);
    await expectHttp(() => rs.getOrgRoom(db, "not-a-uuid", org.id), 400, "Invalid room id.");
    await expectHttp(() => rs.getOrgRoom(db, room.id, again.org.id), 404, "Room not found.");

    const pub = await rs.publishRoom(db, got);
    expect(pub.state).toBe("published");
    const firstPublishedAt = pub.publishedAt;
    expect(firstPublishedAt).toBeTruthy();
    expect((await rs.getPublicRoom(db, room.slug)).state).toBe("published");
    await rs.publishRoom(db, pub);
    expect(pub.publishedAt).toBe(firstPublishedAt);
  });

  it("archived rooms cannot be published; unknown slug 404", async () => {
    const { room } = await makeRoom();
    await expectHttp(() => rs.publishRoom(db, { ...room, state: "archived" }), 409, "Archived rooms cannot be published.");
    await expectHttp(() => rs.getPublicRoom(db, "nope"), 404, "Room not found.");
  });

  it("room2: recipient link is unique and tokenized", async () => {
    const { user, room } = await makeRoom();
    const [r1, l1] = await rs.addRecipient(db, room, { ownerUserId: user.id, name: "Ana Gómez", company: "Ferrovial", email: "a@f.com", bucket: null });
    const [, l2] = await rs.addRecipient(db, room, { ownerUserId: user.id, name: "B", company: null, email: null, bucket: "x" });
    expect(r1.bucket).toBe("infrastructure");
    expect(l1.recipientId).toBe(r1.id);
    expect(l1.token).not.toBe(l2.token);
    expect(l1.token.length).toBeGreaterThanOrEqual(20);
    expect(rs.roomUrl(settings, room.slug, l1.token)).toBe(`https://share.example.com/rooms/${room.slug}?t=${l1.token}`);
    expect(rs.roomUrl(settings, "s", null, { hostname: "localhost:8000" })).toBe("http://localhost:8000/rooms/s");

    const [link, recipient] = await rs.resolveToken(db, l1.token);
    expect(link.id).toBe(l1.id);
    expect(recipient?.name).toBe("Ana Gómez");
    await expectHttp(() => rs.resolveToken(db, "unknown"), 404, "Unknown link token.");

    const anon = await rs.mintLink(db, { roomId: room.id, recipientId: null });
    const [, nobody] = await rs.resolveToken(db, anon.token);
    expect(nobody).toBeNull();
  });

  it("room3: personalization by token, neutral fallbacks for forwarded viewers", () => {
    const room = { personalization: { prepared_for_line: "Prepared for {{company_name}}'s leadership team", hi: "Hi {{contact_first_name}} ({{language}})", n: 5 } };
    expect(rs.renderPersonalization(room, { company: "Ferrovial", name: "Ana Gómez" })).toEqual({
      prepared_for_line: "Prepared for Ferrovial's leadership team",
      hi: "Hi Ana (en)",
    });
    expect(rs.renderPersonalization(room, null)).toEqual({
      prepared_for_line: "Prepared for your team's leadership team",
      hi: "Hi there (en)",
    });
    expect(rs.renderPersonalization({ personalization: {} }, null)).toEqual({ prepared_for_line: "Prepared for your team" });
  });

  it("room5: events recorded and scored", async () => {
    const { user, room } = await makeRoom();
    const [, link] = await rs.addRecipient(db, room, { ownerUserId: user.id, name: "A", company: "C", email: null, bucket: null });
    const ev = await rs.recordEvent(db, { room, link, eventType: rs.EVENT_VIDEO_PROGRESS, payload: { percent: 80 }, sessionId: "s1", country: "ES" });
    expect(ev.recipientId).toBe(link.recipientId);
    expect(ev.linkId).toBe(link.id);
    expect(ev.payload).toEqual({ percent: 80 });
    const anon = await rs.recordEvent(db, { room, link: null, eventType: rs.EVENT_PAGE_VIEW, payload: null, sessionId: null });
    expect(anon.linkId).toBeNull();
    expect(anon.payload).toEqual({});
  });

  it("computeScore", () => {
    const e = (type: string, payload: Record<string, unknown> = {}, sessionId: string | null = "s1") => ({ type, payload, sessionId });
    expect(rs.computeScore([])).toBe(0);
    expect(rs.computeScore([e("video_progress", { percent: 74 })])).toBe(0);
    expect(rs.computeScore([e("video_progress", { percent: "75" })])).toBe(30);
    expect(rs.computeScore([e("doc_view", { percent: 50 })])).toBe(20);
    expect(rs.computeScore([e("page_view", {}, "s1"), e("page_view", {}, "s2")])).toBe(20);
    expect(rs.computeScore([e("return_visit")])).toBe(20);
    expect(rs.computeScore([e("cta_click")])).toBe(20);
    expect(rs.computeScore([e("session", { duration_s: 100 }), e("session", { duration_s: 81 })])).toBe(10);
    expect(rs.computeScore([e("session", { duration_s: 180 })])).toBe(0);
    const all = [
      e("video_progress", { percent: 100 }),
      e("doc_view", { percent: 100 }),
      e("return_visit"),
      e("cta_click"),
      e("session", { duration_s: 500 }),
    ];
    expect(rs.computeScore(all)).toBe(100);
    expect(rs.computeScore(all, { video: 90 })).toBe(100); // clamped
    expect(rs.computeScore([e("cta_click")], { cta: 7 })).toBe(7);
  });
});
