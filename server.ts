import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = 3000;

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
  let url = process.env.SUPABASE_URL?.trim();
  if (url) {
    try {
      const parsed = new URL(url);
      url = `${parsed.protocol}//${parsed.host}`;
    } catch (e) {}
  }
  res.json({
    supabaseUrl: url,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY?.trim()
  });
});

// Helper to get Supabase client
function getSupabaseClient() {
  let url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim();
  
  if (!url || !key) {
    console.warn('Supabase credentials missing in environment.');
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    url = `${parsedUrl.protocol}//${parsedUrl.host}`;
    return createClient(url, key);
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
    
    const supabase = getSupabaseClient();
    if (!supabase) return res.status(400).json({ error: 'Supabase credentials missing.' });
    
    // 1. Check Limits in Database
    let { data: profile, error: profileErr } = await supabase
      .from('user_profiles')
      .select('searches_used, search_limit')
      .eq('id', userId)
      .single();
      
    if (profileErr && profileErr.code === 'PGRST116') {
      // Create mock profile if it doesn't exist
      const { data: newProfile, error: insertErr } = await supabase
        .from('user_profiles')
        .insert({ id: userId, email: 'mock@example.com', search_limit: 100 })
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

    // 2. Search Channels directly
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=50&q=${encodeURIComponent(query)}&key=${key}`;
    const searchRes = await fetch(searchUrl).then(r=>r.json());
    if(searchRes.error) throw new Error(searchRes.error.message);
    if(!searchRes.items || searchRes.items.length === 0) return res.json({ message: 'No channels found', results: [] });

    const channelIds = searchRes.items.map((item: any) => item.snippet.channelId);

    // 3. Channels API Endpoint
    const channelsUrl = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelIds.join(',')}&key=${key}`;
    const channelsRes = await fetch(channelsUrl).then(r=>r.json());
    if(channelsRes.error) throw new Error(channelsRes.error.message);

    const validChannels: any[] = [];
    for (const c of channelsRes.items || []) {
       const subs = parseInt(c.statistics.subscriberCount || '0', 10);
       if (subs >= minSubs && subs <= maxSubs) {
          validChannels.push({
             id: c.id,
             title: c.snippet.title,
             subscriberCount: subs
          });
       }
    }

    // 4. The Playlist Trick & Fetch Videos
    let allRecentVideos: {videoId: string, channel: any}[] = [];
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - (parseInt(timeframeDays as string) || 30));

    await Promise.all(validChannels.map(async (channel) => {
       const uploadsId = 'UU' + channel.id.substring(2);
       const pUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=10&key=${key}`;
       try {
         const pRes = await fetch(pUrl).then(r=>r.json());
         if (pRes.items) {
           pRes.items.forEach((item: any) => {
             const pubDate = new Date(item.snippet.publishedAt);
             if (pubDate >= cutoffDate) {
               allRecentVideos.push({ videoId: item.snippet.resourceId.videoId, channel });
             }
           });
         }
       } catch(e) { console.error(`Error fetching playlist for ${channel.id}:`, e) }
    }));

    if (allRecentVideos.length === 0) return res.json({message: 'No recent videos found in the selected timeframe', results: []});

    // 5. Batch Statistics
    let finalVideos: any[] = [];
    const chunkSize = 50;
    for (let i = 0; i < allRecentVideos.length; i += chunkSize) {
        const chunk = allRecentVideos.slice(i, i + chunkSize);
        const vIds = chunk.map(x => x.videoId).join(',');
        const vUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${vIds}&key=${key}`;
        const vRes = await fetch(vUrl).then(r=>r.json());
        
        if (vRes.items) {
           vRes.items.forEach((vItem: any) => {
              const match = chunk.find(x => x.videoId === vItem.id);
              if (match) {
                 const views = parseInt(vItem.statistics.viewCount || '0', 10);
                 
                 // 6. Calculate Metrics
                 const ratio = match.channel.subscriberCount > 0 ? (views / match.channel.subscriberCount) : 0;
                 
                 finalVideos.push({
                    video_id: vItem.id,
                    channel_id: match.channel.id,
                    channel_name: match.channel.title,
                    title: vItem.snippet.title,
                    thumbnail_url: `https://img.youtube.com/vi/${vItem.id}/hqdefault.jpg`,
                    published_at: vItem.snippet.publishedAt,
                    views: views,
                    subscriber_count: match.channel.subscriberCount,
                    outlier_ratio: parseFloat(ratio.toFixed(4))
                 });
              }
           });
        }
    }

    // Filter < 1000 views and Sort
    const filteredAndSorted = finalVideos
      .filter(v => v.views >= 1000)
      .sort((a, b) => b.outlier_ratio - a.outlier_ratio);

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
           outlier_ratio: v.outlier_ratio,
           published_at: v.published_at
        }));
        
        await supabase.from('outlier_results').insert(resultsToInsert);
      }
    } else if (searchLogErr && searchLogErr.code !== '42P01' && !searchLogErr.message?.includes('does not exist')) {
      console.warn("Could not log search to user_searches:", searchLogErr.message);
    }

    return res.json({ success: true, results: filteredAndSorted });

  } catch (err: any) {
     console.error("Search Outliers Error:", err);
     res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/:userId', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
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
    const supabase = getSupabaseClient();
    if (!supabase) return res.status(400).json({ error: 'Supabase credentials missing.' });
    
    const { data, error } = await supabase
      .from('outlier_results')
      .select('*')
      .eq('search_id', req.params.searchId)
      .order('outlier_ratio', { ascending: false });
      
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

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
