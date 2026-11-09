/** Intranet states, events and actors. Port of backend/app/models/intranet.py. */

export const STATE_SCANNING = "scanning";
export const STATE_SUBMITTED = "submitted";
export const STATE_IN_REVIEW = "in_review";
export const STATE_RELEASED = "released";
export const STATE_REJECTED = "rejected";
export const STATE_CONSUMED = "consumed";
export const STATE_EXPIRED = "expired";
export const STATE_REVOKED = "revoked";
export const STATE_WITHDRAWN = "withdrawn";
export const STATE_CHECK_FAILED = "check_failed";

export const PENDING_STATES = [STATE_SUBMITTED, STATE_IN_REVIEW] as const;
export const REVOCABLE_STATES = [STATE_SCANNING, STATE_SUBMITTED, STATE_IN_REVIEW, STATE_RELEASED] as const;
export const WITHDRAWABLE_STATES = [STATE_SCANNING, STATE_SUBMITTED, STATE_IN_REVIEW] as const;

export const SCAN_PENDING = "pending";
export const SCAN_CLEAN = "clean";
export const SCAN_INFECTED = "infected";
export const SCAN_NOT_SCANNED = "not_scanned";

export const EVENT_SUBMITTED = "submitted";
export const EVENT_CHECK_FAILED = "check_failed";
export const EVENT_OPENED_FOR_REVIEW = "opened_for_review";
export const EVENT_OPENED_BY_SUBMITTER = "opened_by_submitter";
export const EVENT_APPROVED = "approved";
export const EVENT_REJECTED = "rejected";
export const EVENT_ESCALATED = "escalated";
export const EVENT_RELEASED = "released";
export const EVENT_OPENED_BY_RECIPIENT = "opened_by_recipient";
export const EVENT_CONSUMED = "consumed";
export const EVENT_EXPIRED = "expired";
export const EVENT_REVOKED = "revoked";
export const EVENT_WITHDRAWN = "withdrawn";
export const EVENT_INVITED = "member_invited";
export const EVENT_INVITE_REVOKED = "invite_revoked";
export const EVENT_INVITE_EXPIRED = "invite_expired";
export const EVENT_INVITE_ACCEPTED = "invite_accepted";
export const EVENT_MEMBER_UPDATED = "member_updated";
export const EVENT_MEMBER_DEACTIVATED = "member_deactivated";
export const EVENT_MEMBER_REACTIVATED = "member_reactivated";
export const EVENT_SETTINGS_CHANGED = "settings_changed";
export const EVENT_SCANNED = "scanned";
export const EVENT_REMINDER_SENT = "reminder_sent";
export const EVENT_OVERTURNED = "overturned";
export const EVENT_BENCHMARK_RUN = "benchmark_run";
export const EVENT_ACCESS_CODE_FAILED = "access_code_failed";

export const ACTOR_HUMAN = "human";
export const ACTOR_AGENT = "agent";
export const ACTOR_SYSTEM = "system";

export const AGENT_OFF = "off";
export const AGENT_LOCAL = "local";
export const AGENT_JEV = "jev";
export const INPUT_METADATA_ONLY = "metadata_only";
export const INPUT_CONTENT_EXCERPT = "content_excerpt";

export const SWEEPER_ACTOR = "sweeper";
export const INTRANET_KEY_PREFIX = "intranet/";
export const ABANDONED_UPLOAD_SECONDS = 24 * 3600;
