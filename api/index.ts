import express from 'express';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());

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
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim();
  
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

    // Step 1: Search Videos
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=50&q=${encodeURIComponent(query)}&publishedAfter=${publishedAfter}&key=${key}`;
    const searchRes = await fetch(searchUrl).then(r=>r.json());
    if(searchRes.error) throw new Error(searchRes.error.message);
    if(!searchRes.items || searchRes.items.length === 0) return res.json({ message: 'No videos found', results: [] });

    // Extract unique channelIds
    const channelIdsSet = new Set<string>();
    searchRes.items.forEach((item: any) => {
      if (item.snippet && item.snippet.channelId) {
        channelIdsSet.add(item.snippet.channelId);
      }
    });
    const channelIds = Array.from(channelIdsSet);

    // Step 2: Filter by Subs
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

    // Step 3: Playlist Hack
    let allRecentVideos: {videoId: string, channel: any}[] = [];
    
    await Promise.all(validChannels.map(async (channel) => {
       const uploadsId = 'UU' + channel.id.substring(2);
       const pUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=15&key=${key}`;
       try {
         const pRes = await fetch(pUrl).then(r=>r.json());
         if (pRes.items) {
           pRes.items.forEach((item: any) => {
             const pubDate = new Date(item.snippet.publishedAt);
             if (pubDate >= publishedAfterDate) {
               allRecentVideos.push({ videoId: item.snippet.resourceId.videoId, channel });
             }
           });
         }
       } catch(e) { console.error(`Error fetching playlist for ${channel.id}:`, e) }
    }));

    if (allRecentVideos.length === 0) return res.json({message: 'No recent videos found in the selected timeframe', results: []});

    // Step 4: Fetch Stats & Filter Shorts
    let finalVideos: any[] = [];
    const chunkSize = 50;
    
    // Parse duration helper (e.g. PT1M30S)
    const parseDurationToSeconds = (duration: string) => {
      const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (!match) return 0;
      const hours = parseInt(match[1] || '0', 10);
      const minutes = parseInt(match[2] || '0', 10);
      const seconds = parseInt(match[3] || '0', 10);
      return hours * 3600 + minutes * 60 + seconds;
    };

    for (let i = 0; i < allRecentVideos.length; i += chunkSize) {
        const chunk = allRecentVideos.slice(i, i + chunkSize);
        const vIds = chunk.map(x => x.videoId).join(',');
        const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${vIds}&key=${key}`;
        const vRes = await fetch(vUrl).then(r=>r.json());
        
        if (vRes.items) {
           vRes.items.forEach((vItem: any) => {
              const durSecs = parseDurationToSeconds(vItem.contentDetails?.duration || '');
              if (durSecs >= 60) {
                 const match = chunk.find(x => x.videoId === vItem.id);
                 if (match) {
                    const views = parseInt(vItem.statistics.viewCount || '0', 10);
                    finalVideos.push({
                       video_id: vItem.id,
                       channel_id: match.channel.id,
                       channel_name: match.channel.title,
                       title: vItem.snippet.title,
                       published_at: vItem.snippet.publishedAt,
                       views: views,
                       subscriber_count: match.channel.subscriberCount
                    });
                 }
              }
           });
        }
    }

    // Step 5: True Outlier Math
    // Group by channel
    const channelGroups: Record<string, any[]> = {};
    finalVideos.forEach(v => {
      if (!channelGroups[v.channel_id]) channelGroups[v.channel_id] = [];
      channelGroups[v.channel_id].push(v);
    });

    const videosWithScores: any[] = [];
    for (const channelId in channelGroups) {
      const videos = channelGroups[channelId];
      const totalViews = videos.reduce((acc, v) => acc + v.views, 0);
      const baseline_average_views = videos.length > 0 ? Math.round(totalViews / videos.length) : 0;
      
      videos.forEach(v => {
        const outlier_score = baseline_average_views > 0 ? (v.views / baseline_average_views) : 0;
        videosWithScores.push({
          ...v,
          baseline_average_views,
          outlier_score: parseFloat(outlier_score.toFixed(4))
        });
      });
    }

    // Filter < 1000 views and Sort
    const filteredAndSorted = videosWithScores
      .filter(v => v.views >= 1000)
      .sort((a, b) => b.outlier_score - a.outlier_score);

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

export default app;
