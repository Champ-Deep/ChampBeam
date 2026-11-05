-- Clerk membership webhooks can arrive late, retried or out of order. Remember the updated_at (ms) of the
-- last Clerk event applied to each membership so an older event can never rewind a demotion or a removal.
ALTER TABLE organization_memberships ADD COLUMN clerk_updated_at INTEGER;
