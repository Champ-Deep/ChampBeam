-- Visitor journeys (routes/journeys.ts) read every touch of a handful of
-- visitors. EXPLAIN QUERY PLAN showed a clicked_at range scan of click_events
-- for that lookup; this index turns it into a per-visitor seek.
CREATE INDEX IF NOT EXISTS idx_click_events_visitor ON click_events (visitor_id, clicked_at);
