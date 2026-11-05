-- 0003: per-asset CSP sandbox for hosted HTML. Additive and nullable.
-- NULL = legacy page (served as before), 1 = sandboxed, 0 = owner opted out.
-- No existing row is changed.
ALTER TABLE file_assets ADD COLUMN html_sandbox INTEGER;
