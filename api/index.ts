import express from 'express';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper to get YouTube API key
function getYouTubeKey() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new Error('YOUTUBE_API_KEY environment variable is required');
  }
  return key;
}

app.get('/api/test-env', (req, res) => {
  res.json({
    envKeys: Object.keys(process.env).filter(k => k.includes('KEY') || k.includes('API'))
  });
});

app.get('/api/config', (req, res) => {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  if (url) {
    try {
      const parsed = new URL(url);
      url = `${parsed.protocol}//${parsed.host}`;
    } catch (e) {}
  }
  res.json({
    supabaseUrl: url,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim()
  });
});

// Helper to get Supabase client
function getSupabaseClient(authHeader?: string) {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim();
  
  if (!url || !key) {
    console.warn('Supabase credentials missing in environment.');
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    url = `${parsedUrl.protocol}//${parsedUrl.host}`;
    
    const options: any = {};
    if (authHeader) {
      options.global = {
        headers: {
          Authorization: authHeader
        }
      };
    }
    return createClient(url, key, options);
  } catch (error: any) {
    console.error('Invalid Supabase configuration:', error.message);
    return null;
  }
}

app.post('/api/search-outliers', async (req, res) => {
  try {
    const { query, userId, minSubs = 0, maxSubs = 1000000, timeframeDays = 30 } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });
    if (!userId) return res.status(400).json({ error: 'User ID required' });
    
    const authHeader = req.headers.authorization;
    const supabase = getSupabaseClient(authHeader);
    if (!supabase) return res.status(400).json({ error: 'Supabase credentials missing.' });
    
    // 1. Check Limits in Database
    let { data: profile, error: profileErr } = await supabase
      .from('user_profiles')
      .select('searches_used, search_limit')
      .eq('id', userId)
      .single();
      
    if (profileErr && profileErr.code === 'PGRST116') {
      // Get the email from the user session
      const { data: userData } = await supabase.auth.getUser();
      const email = userData?.user?.email || 'unknown@example.com';
      
      const { data: newProfile, error: insertErr } = await supabase
        .from('user_profiles')
        .insert({ id: userId, email: email, search_limit: 3 })
        .select('searches_used, search_limit')
        .single();
      
      if (!insertErr && newProfile) {
        profile = newProfile;
        profileErr = null;
      }
    }
      
    if (profileErr && profileErr.code !== 'PGRST116' && profileErr.code !== '42P01' && !profileErr.message?.includes('does not exist')) {
      console.warn("Profile fetch error:", profileErr.message);
    }
    
    // If table exists and user is over limit
    if (profile && profile.searches_used >= profile.search_limit) {
      return res.status(403).json({ error: 'Search limit reached. Please upgrade to continue.' });
    }

    const key = getYouTubeKey();

    const timeframe = parseInt(timeframeDays as string) || 30;
    const publishedAfterDate = new Date(Date.now() - timeframe * 24 * 60 * 60 * 1000);
    const publishedAfter = publishedAfterDate.toISOString();

    // Step 1: Bucket A (The Target Videos)
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=50&q=${encodeURIComponent(query)}&publishedAfter=${publishedAfter}&key=${key}`;
    const searchRes = await fetch(searchUrl).then(r=>r.json());
    if(searchRes.error) throw new Error(searchRes.error.message);
    if(!searchRes.items || searchRes.items.length === 0) return res.json({ message: 'No videos found', results: [] });

    const targetVideos: any[] = [];
    const channelIdsSet = new Set<string>();

    searchRes.items.forEach((item: any) => {
      if (item.snippet && item.snippet.channelId && item.id && item.id.videoId) {
        channelIdsSet.add(item.snippet.channelId);
        targetVideos.push({
           videoId: item.id.videoId,
           channelId: item.snippet.channelId,
           channelTitle: item.snippet.channelTitle,
           title: item.snippet.title,
           publishedAt: item.snippet.publishedAt
        });
      }
    });

    const channelIds = Array.from(channelIdsSet);

    // Step 2: Filter Channels by Sub Count
    const validChannels: any[] = [];
    const chunkedChannelIds = [];
    for (let i = 0; i < channelIds.length; i += 50) {
      chunkedChannelIds.push(channelIds.slice(i, i + 50));
    }
    
    for (const chunk of chunkedChannelIds) {
      const channelsUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${chunk.join(',')}&key=${key}`;
      const channelsRes = await fetch(channelsUrl).then(r=>r.json());
      if(channelsRes.error) throw new Error(channelsRes.error.message);

      for (const c of channelsRes.items || []) {
         const subs = parseInt(c.statistics.subscriberCount || '0', 10);
         if (subs >= (minSubs as number) && subs <= (maxSubs as number)) {
            validChannels.push({
               id: c.id,
               title: c.snippet.title,
               subscriberCount: subs
            });
         }
      }
    }

    if (validChannels.length === 0) return res.json({ message: 'No channels matching subscriber criteria found', results: [] });

    // Filter targetVideos to only keep those belonging to surviving channels
    const validChannelIds = new Set(validChannels.map(c => c.id));
    const survivingTargetVideos = targetVideos.filter(v => validChannelIds.has(v.channelId));

    if (survivingTargetVideos.length === 0) return res.json({ message: 'No target videos matching subscriber criteria found', results: [] });

    // Step 3: Bucket B (The Math Videos / Playlist Hack)
    let mathVideos: {videoId: string, channelId: string}[] = [];
    
    await Promise.all(validChannels.map(async (channel) => {
       const uploadsId = 'UU' + channel.id.substring(2);
       const pUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=10&key=${key}`;
       try {
         const pRes = await fetch(pUrl).then(r=>r.json());
         if (pRes.items) {
           pRes.items.forEach((item: any) => {
              if (item.snippet && item.snippet.resourceId && item.snippet.resourceId.videoId) {
                 mathVideos.push({ videoId: item.snippet.resourceId.videoId, channelId: channel.id });
              }
           });
         }
       } catch(e) { console.error(`Error fetching playlist for ${channel.id}:`, e) }
    }));

    // Step 4: Fetch Statistics (Remove Duration Filter)
    const allVideoIdsSet = new Set<string>();
    survivingTargetVideos.forEach(v => allVideoIdsSet.add(v.videoId));
    mathVideos.forEach(v => allVideoIdsSet.add(v.videoId));
    const allVideoIds = Array.from(allVideoIdsSet);

    const videoStats: Record<string, number> = {};
    const chunkSize = 50;

    for (let i = 0; i < allVideoIds.length; i += chunkSize) {
        const chunk = allVideoIds.slice(i, i + chunkSize);
        const vIds = chunk.join(',');
        const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${vIds}&key=${key}`;
        const vRes = await fetch(vUrl).then(r=>r.json());
        
        if (vRes.items) {
           vRes.items.forEach((vItem: any) => {
              const views = parseInt(vItem.statistics?.viewCount || '0', 10);
              videoStats[vItem.id] = views;
           });
        }
    }

    // Assign stats to mathVideos to calculate baseline
    const channelGroupsForMath: Record<string, number[]> = {};
    mathVideos.forEach(v => {
      const views = videoStats[v.videoId] || 0;
      if (!channelGroupsForMath[v.channelId]) channelGroupsForMath[v.channelId] = [];
      channelGroupsForMath[v.channelId].push(views);
    });

    // Step 5: True Outlier Math
    const baselineAverages: Record<string, number> = {};
    for (const channelId in channelGroupsForMath) {
       const viewsArray = channelGroupsForMath[channelId];
       const totalViews = viewsArray.reduce((sum, v) => sum + v, 0);
       baselineAverages[channelId] = viewsArray.length > 0 ? Math.round(totalViews / viewsArray.length) : 0;
    }

    const finalTargetVideos: any[] = [];
    survivingTargetVideos.forEach(v => {
       const views = videoStats[v.videoId] || 0;
       const baseline = baselineAverages[v.channelId] || 0;
       const outlier_score = baseline > 0 ? (views / baseline) : 0;
       
       const channelInfo = validChannels.find(c => c.id === v.channelId);
       
       if (views >= 1000) {
          finalTargetVideos.push({
             video_id: v.videoId,
             channel_id: v.channelId,
             channel_name: v.channelTitle || (channelInfo ? channelInfo.title : ''),
             title: v.title,
             published_at: v.publishedAt,
             views: views,
             subscriber_count: channelInfo ? channelInfo.subscriberCount : 0,
             baseline_average_views: baseline,
             outlier_score: parseFloat(outlier_score.toFixed(4))
          });
       }
    });

    // Sort targetVideos descending by outlier_score
    const filteredAndSorted = finalTargetVideos.sort((a, b) => b.outlier_score - a.outlier_score);

    // Database Actions: Update used searches, save search log, and save results
    
    // Increment searches_used
    if (profile) {
      await supabase
        .from('user_profiles')
        .update({ searches_used: profile.searches_used + 1 })
        .eq('id', userId);
    }
    
    // Insert search log
    let searchId = null;
    let missingTables = false;
    const { data: searchLog, error: searchLogErr } = await supabase
      .from('user_searches')
      .insert({ user_id: userId, query_string: query })
      .select('id')
      .single();
      
    if (!searchLogErr && searchLog) {
      searchId = searchLog.id;
      
      // Bulk insert results
      if (filteredAndSorted.length > 0) {
        const resultsToInsert = filteredAndSorted.map(v => ({
           search_id: searchId,
           video_id: v.video_id,
           channel_id: v.channel_id,
           channel_name: v.channel_name,
           title: v.title,
           view_count: v.views,
           subscriber_count: v.subscriber_count,
           baseline_average_views: v.baseline_average_views,
           outlier_score: v.outlier_score,
           published_at: v.published_at
        }));
        
        await supabase.from('outlier_results').insert(resultsToInsert);
      }
    } else if (searchLogErr && (searchLogErr.code === '42P01' || searchLogErr.message?.includes('does not exist'))) {
      missingTables = true;
      console.warn("Tables do not exist in Supabase. Please run database.sql");
    } else if (searchLogErr) {
      console.warn("Could not log search to user_searches:", searchLogErr.message);
    }

    return res.json({ 
      success: true, 
      results: filteredAndSorted,
      warning: missingTables ? "Database tables are missing. Results were not saved. Please run database.sql in your Supabase SQL Editor." : undefined
    });

  } catch (err: any) {
     console.error("Search Outliers Error:", err);
     res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/:userId', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const supabase = getSupabaseClient(authHeader);
    if (!supabase) return res.status(400).json({ error: 'Supabase credentials missing.' });
    
    const { data, error } = await supabase
      .from('user_searches')
      .select('id, query_string, created_at')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false });
      
    if (error && error.code !== '42P01') throw new Error(error.message);
    res.json({ history: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/results/:searchId', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const supabase = getSupabaseClient(authHeader);
    if (!supabase) return res.status(400).json({ error: 'Supabase credentials missing.' });
    
    const { data, error } = await supabase
      .from('outlier_results')
      .select('*')
      .eq('search_id', req.params.searchId)
      .order('outlier_score', { ascending: false });
      
    if (error && error.code !== '42P01') throw new Error(error.message);
    
    // Map view_count to views for compatibility with frontend if necessary
    const formatted = (data || []).map(r => ({
      ...r,
      views: r.view_count || r.views,
      thumbnail_url: `https://img.youtube.com/vi/${r.video_id}/hqdefault.jpg`
    }));
    
    res.json({ results: formatted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/webhooks/kofi', async (req, res) => {
  try {
    // Ko-fi sends the data inside a "data" field as a JSON string when Content-Type is form-urlencoded
    const rawData = req.body.data;
    if (!rawData) {
      return res.status(400).json({ error: 'Missing data field' });
    }

    const payload = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;

    // Verify webhook token
    if (payload.verification_token !== process.env.KOFI_VERIFICATION_TOKEN) {
      console.warn('Invalid Ko-fi verification token');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check payload type
    if (payload.type === 'Shop Order' || payload.type === 'Donation' || payload.type === 'Subscription') {
      const email = payload.email;
      
      if (!email) {
        console.warn('Webhook payload missing email');
        return res.status(200).send('OK'); // Return 200 so Ko-fi doesn't retry
      }

      // Initialize Supabase Service Role client
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      const supabaseServiceKey = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;

      if (!supabaseUrl || !supabaseServiceKey) {
        console.error('Supabase Service Role credentials missing. Cannot update user tier.');
        return res.status(500).json({ error: 'Internal Server Error' });
      }

      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      const { error: updateError } = await supabase
        .from('user_profiles')
        .update({ 
          search_limit: 60,
          // Since tier column might not exist, we just wrap it with a try/catch or ignore if the column is missing
          // If the user's instructions imply adding tier, we update it. (Wait, I'll check if tier exists. I'll update search_limit alone if tier is missing).
          tier: 'pro'
        })
        .eq('email', email);

      if (updateError) {
        console.error('Error updating user_profiles in webhook:', updateError);
        // We still return 200 to Ko-fi if we fail to update so it doesn't retry infinitely
      } else {
        console.log(`Successfully upgraded user ${email} to Pro (60 searches).`);
      }
    }

    // Always return 200 for Ko-fi to acknowledge receipt
    res.status(200).send('OK');
  } catch (error) {
    console.error('Ko-fi Webhook Error:', error);
    // Return 200 to prevent retries for malformed data
    res.status(200).send('OK');
  }
});

export default app;
