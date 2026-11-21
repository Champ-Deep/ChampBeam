-- 0004: link attribution slice 1. Additive; existing rows keep NULL / 0.
-- track_conversions: append cb_id=<click_events.id> to the destination.
-- is_scanner: email-security prefetch, flagged never dropped.
ALTER TABLE link_clicks ADD COLUMN track_conversions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE click_events ADD COLUMN channel TEXT;
ALTER TABLE click_events ADD COLUMN visitor_type TEXT;
ALTER TABLE click_events ADD COLUMN is_scanner INTEGER NOT NULL DEFAULT 0;
