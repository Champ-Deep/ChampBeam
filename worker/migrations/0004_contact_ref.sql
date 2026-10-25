-- Bind a tracked link to one external contact (e.g. a ChampVoice drop_id), so an
-- open can be attributed to a person we already know instead of guessed from the IP.
ALTER TABLE link_clicks ADD COLUMN contact_ref TEXT;
CREATE INDEX idx_link_clicks_contact_ref ON link_clicks (contact_ref);
