-- 1. Drop existing tables if they exist
DROP TABLE IF EXISTS outlier_results CASCADE;
DROP TABLE IF EXISTS user_searches CASCADE;
DROP TABLE IF EXISTS user_profiles CASCADE;


-- 2. Create User Profiles Table (Tracks search limits)
-- Note: In the future, this can reference auth.users(id), but for now we remove the FK 
-- so that the app can be used without login using a generated mock user ID.
CREATE TABLE user_profiles (
    id UUID PRIMARY KEY,
    email TEXT,
    tier TEXT DEFAULT 'free', -- 'free', 'pro', or 'lifetime'
    searches_used INT DEFAULT 0,
    search_limit INT DEFAULT 30, -- Increased limit since we removed auth
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create Searches Table (Stores the exact query the user made)
CREATE TABLE user_searches (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
    query_string TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Create Outlier Results Table (Stores the actual videos found)
CREATE TABLE outlier_results (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    search_id UUID REFERENCES user_searches(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    subscriber_count BIGINT DEFAULT 0,
    view_count BIGINT DEFAULT 0,
    outlier_ratio NUMERIC, -- Views / Subs
    published_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Disable RLS for now since login is removed.
-- (We will re-enable it when you integrate auth later)
ALTER TABLE user_profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_searches DISABLE ROW LEVEL SECURITY;
ALTER TABLE outlier_results DISABLE ROW LEVEL SECURITY;
