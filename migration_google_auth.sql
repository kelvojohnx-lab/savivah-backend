-- Run this against your EXISTING database to add Google sign-in support
-- without losing data. Fresh installs get this already via schema.sql.
--
-- Usage: psql "<your DATABASE_URL>" -f migration_google_auth.sql

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;   -- Google-only accounts have no password
ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL;    -- Google doesn't provide a phone number
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
