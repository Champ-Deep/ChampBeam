-- Company cache lookup (companyIntel.cachedCompany) reads click_events by IP.
CREATE INDEX IF NOT EXISTS idx_click_events_ip ON click_events (ip_address);
