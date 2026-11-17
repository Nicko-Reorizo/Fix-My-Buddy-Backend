ALTER TABLE mechanic_profiles ADD COLUMN IF NOT EXISTS location_source TEXT NOT NULL DEFAULT 'gps';
ALTER TABLE mechanic_profiles ADD COLUMN IF NOT EXISTS location_address TEXT NOT NULL DEFAULT '';
