-- TXT records Cloudflare for SaaS asks for (ownership + certificate), stored as a JSON array of
-- {type,name,value,purpose} so the Settings screen and records.txt can show them without a CF call.
ALTER TABLE domains ADD COLUMN cf_dns_records TEXT;
