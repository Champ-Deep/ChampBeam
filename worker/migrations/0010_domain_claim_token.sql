-- DNS TXT proof of hostname ownership. Active rows are grandfathered (NULL token).
ALTER TABLE domains ADD COLUMN verification_token TEXT;
UPDATE domains SET verification_token = lower(hex(randomblob(16))) WHERE status != 'active';
-- Global hostname uniqueness becomes active-only, so an unproven claim no longer reserves a name.
DROP INDEX idx_domains_hostname;
CREATE UNIQUE INDEX idx_domains_hostname_active ON domains (hostname) WHERE status = 'active';
CREATE INDEX idx_domains_hostname_lookup ON domains (hostname);
