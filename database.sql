-- 1. Drop existing tables if they exist
DROP TABLE IF EXISTS outlier_results CASCADE;
DROP TABLE IF EXISTS user_searches CASCADE;
DROP TABLE IF EXISTS user_profiles CASCADE;

-- 2. Create User Profiles Table (Tracks search limits)
CREATE TABLE user_profiles (
    id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
    email TEXT,
    tier TEXT DEFAULT 'free', -- 'free', 'pro', or 'lifetime'
    searches_used INT DEFAULT 0,
    search_limit INT DEFAULT 3, -- Free tier gets 3 searches
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
    baseline_average_views BIGINT DEFAULT 0,
    outlier_score NUMERIC,
    published_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Enable RLS
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlier_results ENABLE ROW LEVEL SECURITY;

-- 6. Create RLS Policies
CREATE POLICY "Users can view their own profile" ON user_profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can insert their own profile" ON user_profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update their own profile" ON user_profiles FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can view their own searches" ON user_searches FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own searches" ON user_searches FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own results" ON outlier_results FOR SELECT USING (
    EXISTS (SELECT 1 FROM user_searches WHERE user_searches.id = outlier_results.search_id AND user_searches.user_id = auth.uid())
);
CREATE POLICY "Users can insert results" ON outlier_results FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM user_searches WHERE user_searches.id = outlier_results.search_id AND user_searches.user_id = auth.uid())
);
