/**
 * Drizzle schema for D1. Mirrors migrations/0001_init.sql exactly (the SQL file
 * is the source of truth for DDL; this file gives typed queries). Ported from
 * backend/app/models/*.py — column names are identical so data migrates 1:1.
 *
 * Conventions: ids are TEXT UUIDs (crypto.randomUUID), timestamps are ISO-8601
 * UTC TEXT ("...Z", see lib/time.ts), booleans are 0/1, JSON is TEXT.
 */
import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { nowIso } from "../lib/time";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = (nullable = false) =>
  nullable
    ? text("created_at").$defaultFn(nowIso)
    : text("created_at").notNull().$defaultFn(nowIso);
const updatedAt = () => text("updated_at").$defaultFn(nowIso).$onUpdateFn(nowIso);
const bool = (name: string) => integer(name, { mode: "boolean" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

// ---------------------------------------------------------------------------
// users / orgs / keys
// ---------------------------------------------------------------------------

export const users = sqliteTable("users", {
  id: id(),
  clerkId: text("clerk_id"),
  email: text("email").notNull(),
  hashedPassword: text("hashed_password"),
  fullName: text("full_name"),
  isActive: bool("is_active").default(true),
  createdAt: createdAt(true),
  updatedAt: updatedAt(),
  lastLogin: text("last_login"),
});

export const ROLE_ADMIN = "admin";
export const ROLE_SUPER_ADMIN = "super_admin";
export const ROLE_LEADER = "leader";
export const ROLE_MEMBER = "member";

export const organizations = sqliteTable("organizations", {
  id: id(),
  clerkOrgId: text("clerk_org_id").notNull(),
  name: text("name"),
  slug: text("slug"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organizationMemberships = sqliteTable("organization_memberships", {
  id: id(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default(ROLE_MEMBER),
  clerkMembershipId: text("clerk_membership_id"),
  leaderUserId: text("leader_user_id").references(() => users.id, { onDelete: "set null" }),
  /** "active" | "revoked". Revoked is a tombstone: token sync never revives it. */
  status: text("status").notNull().default("active"),
  revokedAt: text("revoked_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const MEMBERSHIP_ACTIVE = "active";
export const MEMBERSHIP_REVOKED = "revoked";

export const reportingGrants = sqliteTable("reporting_grants", {
  id: id(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** "org" = whole org, "team" = reps of leaderUserId (plus the leader). */
  scope: text("scope").notNull(),
  leaderUserId: text("leader_user_id").references(() => users.id, { onDelete: "cascade" }),
  grantedByUserId: text("granted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  revokedAt: text("revoked_at"),
});

export const slugAliases = sqliteTable("slug_aliases", {
  id: id(),
  fileId: text("file_id")
    .notNull()
    .references(() => fileAssets.id, { onDelete: "cascade" }),
  domainId: text("domain_id").references(() => domains.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  createdAt: createdAt(),
});

export const API_KEY_PREFIX = "cb_live_";

export const apiKeys = sqliteTable("api_keys", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  scopes: json<unknown>("scopes"),
  lastUsedAt: text("last_used_at"),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// UTM / links / clicks
// ---------------------------------------------------------------------------

export const utmPresets = sqliteTable("utm_presets", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isDefault: bool("is_default").default(false),
  isShared: bool("is_shared").default(false),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  customParams: json<Record<string, unknown>>("custom_params"),
  createdAt: createdAt(true),
  updatedAt: updatedAt(),
});

export const projects = sqliteTable("projects", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: createdAt(true),
  updatedAt: updatedAt(),
});

export const DOMAIN_STATUS_PENDING_CNAME = "pending_cname";
export const DOMAIN_STATUS_PENDING_SSL = "pending_ssl";
export const DOMAIN_STATUS_ACTIVE = "active";
export const DOMAIN_STATUS_FAILED = "failed";

export const domains = sqliteTable("domains", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostname: text("hostname").notNull(),
  status: text("status").notNull().default(DOMAIN_STATUS_PENDING_CNAME),
  cfCustomHostnameId: text("cf_custom_hostname_id"),
  sslStatus: text("ssl_status"),
  verificationErrors: json<unknown>("verification_errors"),
  isPrimary: bool("is_primary").notNull().default(false),
  createdAt: createdAt(),
  verifiedAt: text("verified_at"),
  lastCheckedAt: text("last_checked_at"),
  provisionRequestedAt: text("provision_requested_at"),
  provisionAttempts: integer("provision_attempts").notNull().default(0),
  registrar: text("registrar"),
  registrationStatus: text("registration_status"),
  autoRenew: bool("auto_renew").notNull().default(false),
  registrationPrice: text("registration_price"),
  domainExpiresAt: text("domain_expires_at"),
  /** Set for an org-owned domain (administered by org admins, usable by members). */
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  isOrgDefault: bool("is_org_default").notNull().default(false),
});

export const linkClicks = sqliteTable("link_clicks", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  domainId: text("domain_id").references(() => domains.id, { onDelete: "set null" }),
  shortCode: text("short_code"),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  projectName: text("project_name"),
  originalUrl: text("original_url").notNull(),
  trackedUrl: text("tracked_url"),
  anchorText: text("anchor_text"),
  linkPosition: integer("link_position"),
  champvaultAssetId: text("champvault_asset_id"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  clickCount: integer("click_count").default(0),
  uniqueClicks: integer("unique_clicks").default(0),
  firstClickedAt: text("first_clicked_at"),
  lastClickedAt: text("last_clicked_at"),
  expiresAt: text("expires_at"),
  maxViews: integer("max_views"),
  revokedAt: text("revoked_at"),
  requireEmail: bool("require_email").notNull().default(false),
  blockVpn: bool("block_vpn").notNull().default(false),
  branded: bool("branded").notNull().default(false),
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  createdAt: createdAt(true),
});

export const FILE_KIND_PDF = "pdf";
export const FILE_KIND_VIDEO = "video";
export const FILE_KIND_HTML = "html";
export const FILE_KIND_IMAGE = "image";
export const FILE_KIND_OTHER = "other";
export const FILE_STATUS_PENDING_UPLOAD = "pending_upload";
export const FILE_STATUS_ACTIVE = "active";
export const FILE_STATUS_FAILED = "failed";
export const FILE_STATUS_DELETED = "deleted";
export const SERVE_STREAM = "stream";
export const SERVE_REDIRECT = "redirect";

export const fileAssets = sqliteTable("file_assets", {
  id: id(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  domainId: text("domain_id").references(() => domains.id, { onDelete: "set null" }),
  shortCode: text("short_code").notNull(),
  slug: text("slug"),
  filename: text("filename").notNull(),
  kind: text("kind").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  sha256: text("sha256"),
  storageKey: text("storage_key").notNull(),
  status: text("status").notNull().default(FILE_STATUS_PENDING_UPLOAD),
  serveMode: text("serve_mode").notNull().default(SERVE_STREAM),
  viewCount: integer("view_count").notNull().default(0),
  lastViewedAt: text("last_viewed_at"),
  createdAt: createdAt(),
  expiresAt: text("expires_at"),
  maxViews: integer("max_views"),
  revokedAt: text("revoked_at"),
  requireEmail: bool("require_email").notNull().default(false),
  blockVpn: bool("block_vpn").notNull().default(false),
  branded: bool("branded").notNull().default(false),
  ownerTokenHash: text("owner_token_hash"),
  stateToken: text("state_token"),
  accessCodeHash: text("access_code_hash"),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "set null" }),
  /** "download" | "host"; null = legacy asset, behaviour unchanged. */
  shareIntent: text("share_intent"),
});

export const fileVersions = sqliteTable("file_versions", {
  id: id(),
  fileId: text("file_id")
    .notNull()
    .references(() => fileAssets.id, { onDelete: "cascade" }),
  versionNo: integer("version_no").notNull(),
  storageKey: text("storage_key").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  sha256: text("sha256"),
  filename: text("filename").notNull(),
  createdAt: createdAt(),
});

export const clickEvents = sqliteTable("click_events", {
  id: id(),
  linkId: text("link_id").references(() => linkClicks.id, { onDelete: "cascade" }),
  fileId: text("file_id").references(() => fileAssets.id, { onDelete: "cascade" }),
  domainId: text("domain_id").references(() => domains.id, { onDelete: "set null" }),
  visitorId: text("visitor_id"),
  isRevisit: bool("is_revisit").notNull().default(false),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  referrer: text("referrer"),
  deviceType: text("device_type"),
  browser: text("browser"),
  os: text("os"),
  country: text("country"),
  countryCode: text("country_code"),
  region: text("region"),
  city: text("city"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  isVpn: bool("is_vpn").notNull().default(false),
  asnOrg: text("asn_org"),
  companyName: text("company_name"),
  companyDomain: text("company_domain"),
  companyIndustry: text("company_industry"),
  companySize: text("company_size"),
  companyType: text("company_type"),
  clickedAt: text("clicked_at").notNull().$defaultFn(nowIso),
});

export const linkTags = sqliteTable("link_tags", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
  createdAt: createdAt(true),
});

export const linkTagAssociations = sqliteTable(
  "link_tag_associations",
  {
    linkId: text("link_id")
      .notNull()
      .references(() => linkClicks.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => linkTags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.linkId, t.tagId] })],
);

// ---------------------------------------------------------------------------
// Org content library / assignments / favorites / leads
// ---------------------------------------------------------------------------

export const CONTENT_KIND_FILE = "file";
export const CONTENT_KIND_LINK = "link";

export const contentItems = sqliteTable("content_items", {
  id: id(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  kind: text("kind").notNull(),
  canonicalUrl: text("canonical_url"),
  champvaultAssetId: text("champvault_asset_id"),
  fileId: text("file_id").references(() => fileAssets.id, { onDelete: "set null" }),
  isArchived: bool("is_archived").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const contentShares = sqliteTable("content_shares", {
  id: id(),
  contentId: text("content_id")
    .notNull()
    .references(() => contentItems.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  sharedByUserId: text("shared_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  linkId: text("link_id").references(() => linkClicks.id, { onDelete: "set null" }),
  fileId: text("file_id").references(() => fileAssets.id, { onDelete: "set null" }),
  domainId: text("domain_id").references(() => domains.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const assignments = sqliteTable("assignments", {
  id: id(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  champvaultAssetId: text("champvault_asset_id").notNull(),
  assetTitle: text("asset_title"),
  assignedToUserId: text("assigned_to_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  assignedByUserId: text("assigned_by_user_id").references(() => users.id, { onDelete: "set null" }),
  note: text("note"),
  createdAt: createdAt(),
});

export const champvaultFavorites = sqliteTable("champvault_favorites", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  champvaultAssetId: text("champvault_asset_id").notNull(),
  createdAt: createdAt(),
});

export const accessLeads = sqliteTable("access_leads", {
  id: id(),
  linkId: text("link_id").references(() => linkClicks.id, { onDelete: "cascade" }),
  fileId: text("file_id").references(() => fileAssets.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  ipAddress: text("ip_address"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Briefing rooms
// ---------------------------------------------------------------------------

export const ROOM_DRAFT = "draft";
export const ROOM_PUBLISHED = "published";
export const ROOM_ARCHIVED = "archived";

export const rooms = sqliteTable("rooms", {
  id: id(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  bucket: text("bucket"),
  state: text("state").notNull().default(ROOM_DRAFT),
  assetIds: json<string[]>("asset_ids")
    .notNull()
    .$defaultFn(() => []),
  personalization: json<Record<string, unknown>>("personalization")
    .notNull()
    .$defaultFn(() => ({})),
  publishedAt: text("published_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const roomRecipients = sqliteTable("room_recipients", {
  id: id(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name"),
  company: text("company"),
  email: text("email"),
  bucket: text("bucket"),
  createdAt: createdAt(),
});

export const roomLinks = sqliteTable("room_links", {
  id: id(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  recipientId: text("recipient_id").references(() => roomRecipients.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  createdAt: createdAt(),
  expiresAt: text("expires_at"),
});

export const roomEvents = sqliteTable("room_events", {
  id: id(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  linkId: text("link_id").references(() => roomLinks.id, { onDelete: "set null" }),
  recipientId: text("recipient_id").references(() => roomRecipients.id, { onDelete: "set null" }),
  sessionId: text("session_id"),
  type: text("type").notNull(),
  payload: json<Record<string, unknown>>("payload")
    .notNull()
    .$defaultFn(() => ({})),
  country: text("country"),
  city: text("city"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Beam Pages: engagement, comments, state, events
// ---------------------------------------------------------------------------

export const pageEngagements = sqliteTable("page_engagements", {
  id: id(),
  fileId: text("file_id")
    .notNull()
    .references(() => fileAssets.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  visitorId: text("visitor_id"),
  page: integer("page").notNull(),
  dwellMs: integer("dwell_ms").notNull(),
  ipAddress: text("ip_address"),
  createdAt: createdAt(),
});

export const PAGE_EVENT_COMMENT_ADDED = "comment_added";
export const PAGE_EVENT_STATE_CHANGED = "state_changed";
export const PAGE_EVENT_GATE_FAILED = "gate_failed";

export const pageComments = sqliteTable("page_comments", {
  id: id(),
  pageId: text("page_id")
    .notNull()
    .references(() => fileAssets.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  body: text("body").notNull(),
  visitorId: text("visitor_id"),
  ip: text("ip"),
  createdAt: createdAt(),
});

export const pageState = sqliteTable("page_state", {
  id: id(),
  pageId: text("page_id")
    .notNull()
    .references(() => fileAssets.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: json<unknown>("value"),
  updatedAt: text("updated_at").notNull().$defaultFn(nowIso),
  updatedByVisitor: text("updated_by_visitor"),
});

export const pageEvents = sqliteTable("page_events", {
  id: id(),
  pageId: text("page_id")
    .notNull()
    .references(() => fileAssets.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  ref: text("ref"),
  visitorId: text("visitor_id"),
  ip: text("ip"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

export const maxmindUsage = sqliteTable("maxmind_usage", {
  day: text("day").primaryKey(),
  lookups: integer("lookups").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  queriesRemaining: integer("queries_remaining"),
  updatedAt: text("updated_at").notNull().$defaultFn(nowIso),
});

export const rateCounters = sqliteTable("rate_counters", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  expiresAt: integer("expires_at").notNull(),
});

