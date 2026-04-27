import React, { useState, useEffect } from 'react';
import { Activity, Search, AlertCircle, Youtube, LogOut, Clock, Download, SlidersHorizontal, ChevronRight, Menu, X } from 'lucide-react';
import { createClient, Session, SupabaseClient } from '@supabase/supabase-js';

interface OutlierResult {
  video_id: string;
  channel_id: string;
  channel_name: string;
  title: string;
  thumbnail_url: string;
  views: number;
  subscriber_count: number;
  outlier_ratio: number;
  published_at: string;
}

interface SearchHistory {
  id: string;
  query_string: string;
  created_at: string;
}

export default function App() {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);

  // Auth State
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState('');

  // Dashboard State
  const [history, setHistory] = useState<SearchHistory[]>([]);
  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Search State
  const [query, setQuery] = useState('');
  const [minSubs, setMinSubs] = useState(0);
  const [maxSubs, setMaxSubs] = useState(1000000);
  const [timeframe, setTimeframe] = useState(30);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<OutlierResult[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then(config => {
        if (config.supabaseUrl && config.supabaseAnonKey) {
          const client = createClient(config.supabaseUrl, config.supabaseAnonKey);
          setSupabase(client);
          
          client.auth.getSession().then(({ data }) => {
            setSession(data.session);
            setLoadingConfig(false);
          });

          client.auth.onAuthStateChange((_event, newSession) => {
            setSession(newSession);
          });
        } else {
          setLoadingConfig(false);
        }
      })
      .catch((e) => {
        console.error("Config fetch error:", e);
        setLoadingConfig(false);
      });
  }, []);

  // Handle OAuth callback inside the popup window
  useEffect(() => {
    if (window.location.pathname.startsWith('/auth/callback') && supabase) {
       supabase.auth.getSession().then(() => {
           if (window.opener) {
               window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
               window.close();
           } else {
               window.location.href = '/';
           }
       });
    }
  }, [supabase]);

  // Handle messages from the oauth popup
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS' && supabase) {
         supabase.auth.getSession().then(({ data }) => setSession(data.session));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [supabase]);


  useEffect(() => {
    if (supabase) {
      fetchHistory();
    }
  }, [supabase]);

  const fetchHistory = async () => {
    if (!session) return;
    try {
      const res = await fetch(`/api/history/${session.user.id}`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`
        }
      });
      const data = await res.json();
      if (res.ok) {
        setHistory(data.history || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (window.location.pathname.startsWith('/auth/callback')) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 text-center font-sans">
        <div className="w-8 h-8 rounded-full border-2 border-gray-300 border-t-black animate-spin mb-4" />
        <p className="font-medium text-gray-900 text-sm">Authenticating...</p>
        <p className="text-gray-500 text-xs mt-2">This window should close automatically.</p>
      </div>
    );
  }

  const handleGoogleLogin = async () => {
    if (!supabase) return setAuthError('Supabase config missing');
    setAuthLoading(true);
    setAuthError('');
    
    // Popup-based OAuth flow for iframe environments
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        skipBrowserRedirect: true, 
      }
    });

    if (error) {
      setAuthError(error.message);
      setAuthLoading(false);
      return;
    }

    if (data?.url) {
      const authWindow = window.open(data.url, 'oauth_popup', 'width=600,height=700');
      if (!authWindow) {
        setAuthError('Please allow popups for this site to sign in with Google.');
      }
    }
    setAuthLoading(false);
  };

  const handleLogout = async () => {
    supabase?.auth.signOut();
    setResults([]);
    setHistory([]);
    setActiveSearchId(null);
  };

  const loadPastSearch = async (searchId: string) => {
    setActiveSearchId(searchId);
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/results/${searchId}`, {
        headers: {
          'Authorization': `Bearer ${session?.access_token}`
        }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load results');
      setResults(data.results || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      setSidebarOpen(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || !session?.user?.id) return;
    setLoading(true);
    setError('');
    setActiveSearchId(null);
    setResults([]);

    try {
      const res = await fetch('/api/search-outliers', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          query,
          userId: session.user.id,
          minSubs,
          maxSubs,
          timeframeDays: timeframe
        })
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to search outliers.');
      }
      
      setResults(data.results || []);
      fetchHistory(); // Refresh sidebar
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const exportCSV = () => {
    if (results.length === 0) return;
    
    // Explicitly dropping likes/comments from exports too
    const headers = ['Video ID', 'Title', 'Channel', 'Views', 'Subscribers', 'Outlier Ratio', 'Published At', 'URL'];
    const rows = results.map(r => [
      r.video_id,
      `"${(r.title || '').replace(/"/g, '""')}"`,
      `"${(r.channel_name || '').replace(/"/g, '""')}"`,
      r.views,
      r.subscriber_count,
      r.outlier_ratio,
      r.published_at,
      `https://youtube.com/watch?v=${r.video_id}`
    ]);
    
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `outlier-results-${new Date().getTime()}.csv`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loadingConfig) {
    return <div className="min-h-screen bg-gray-50 flex items-center justify-center font-sans">
      <div className="w-8 h-8 rounded-full border-2 border-gray-300 border-t-black animate-spin" />
    </div>;
  }

  if (!supabase) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6 font-sans">
        <div className="max-w-md w-full bg-white border border-red-200 rounded-xl p-6 text-center shadow-sm">
          <AlertCircle size={32} className="mx-auto text-red-500 mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Database Connection Missing</h2>
          <p className="text-gray-600 text-sm">Please set the <code className="bg-gray-100 px-1 py-0.5 rounded">NEXT_PUBLIC_SUPABASE_URL</code> and <code className="bg-gray-100 px-1 py-0.5 rounded">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> environment variables in your deployment settings (like Vercel or AI Studio) to continue.</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 font-sans">
         <div className="w-12 h-12 bg-black rounded-xl flex items-center justify-center mb-6 shadow-md">
            <Activity size={24} color="white" />
         </div>
         <div className="max-w-md w-full bg-white border border-gray-200 rounded-2xl p-8 shadow-sm text-center">
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 mb-2">Welcome to Outlier Finder</h1>
            <p className="text-gray-500 text-sm mb-8">Discover high-performing YouTube channels in seconds.</p>
            
            {authError && (
              <div className="mb-6 p-3 bg-red-50 text-red-800 text-sm rounded-lg border border-red-100 flex items-start gap-2 text-left">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <p>{authError}</p>
              </div>
            )}
            
            <button 
              onClick={handleGoogleLogin}
              disabled={authLoading}
              className="cursor-pointer w-full flex items-center justify-center gap-3 bg-white border border-gray-300 text-gray-800 rounded-xl py-3 px-4 text-sm font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50 shadow-sm"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C4.01 20.61 7.71 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.71 1 4.01 3.39 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              {authLoading ? 'Signing in...' : 'Continue with Google'}
            </button>
            <p className="mt-5 text-xs text-gray-400">
              By continuing, you agree to our Terms of Service and Privacy Policy.
            </p>
         </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      <header className="h-[60px] bg-white border-b border-gray-200 flex items-center justify-between px-4 sm:px-6 shrink-0 sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <button className="md:hidden p-1 text-gray-500 hover:text-black hover:bg-gray-100 rounded-md" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
            <Activity size={18} color="white" />
          </div>
          <span className="font-semibold text-gray-900 tracking-tight text-lg hidden sm:block">Outlier Finder</span>
        </div>
        
        <div className="flex items-center gap-4 text-sm font-medium">
           <span className="text-gray-500 hidden sm:block">{session?.user?.email}</span>
           <button onClick={handleLogout} className="flex items-center gap-2 text-gray-600 hover:text-black transition-colors px-3 py-1.5 rounded-md hover:bg-gray-100">
             <LogOut size={16} /> <span className="hidden sm:inline">Logout</span>
           </button>
        </div>
      </header>
      
      <div className="flex flex-1 overflow-hidden relative">
        {/* Overlay for mobile sidebar */}
        {sidebarOpen && (
           <div className="fixed inset-0 bg-black/20 z-20 md:hidden block" onClick={() => setSidebarOpen(false)} />
        )}
        
        {/* Sidebar */}
        <aside className={`absolute md:static w-[280px] h-full bg-white border-r border-gray-200 flex flex-col z-30 transition-transform duration-200 ease-in-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
           <div className="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-50/50">
             <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-2">
               <Clock size={14} /> Search History
             </h2>
             <button className="md:hidden text-gray-400 hover:text-black" onClick={() => setSidebarOpen(false)}>
               <X size={16} />
             </button>
           </div>
           
           <div className="flex-1 overflow-y-auto">
             {history.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">
                  No previous searches yet.
                </div>
             ) : (
                <ul className="py-2">
                  {history.map(item => (
                    <li key={item.id}>
                      <button 
                        onClick={() => loadPastSearch(item.id)}
                        className={`w-full text-left px-5 py-3 hover:bg-gray-50 border-l-[3px] transition-all flex items-center justify-between group ${activeSearchId === item.id ? 'border-black bg-gray-50' : 'border-transparent'}`}
                      >
                        <div className="flex flex-col gap-0.5 overflow-hidden">
                          <span className="text-sm font-medium text-gray-900 truncate pr-2">{item.query_string}</span>
                          <span className="text-xs text-gray-500">{new Date(item.created_at).toLocaleDateString()}</span>
                        </div>
                        <ChevronRight size={14} className={`shrink-0 text-gray-300 group-hover:text-gray-500 transition-colors ${activeSearchId === item.id ? 'text-gray-600' : ''}`} />
                      </button>
                    </li>
                  ))}
                </ul>
             )}
           </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 max-w-6xl w-full mx-auto p-4 md:p-8 overflow-y-auto w-full">
          {error && (
            <div className="mb-8 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-red-800">
              <AlertCircle size={20} className="mt-0.5 shrink-0" />
              <p className="text-sm">{error}</p>
            </div>
          )}

          {/* Configuration & Search Bar */}
          <div className="bg-white p-5 md:p-6 rounded-2xl border border-gray-200 shadow-sm mb-8">
            <form onSubmit={handleSearch} className="flex flex-col gap-5">
              
              <div className="relative">
                <input
                  type="text"
                  placeholder="Analyze a niche or topic (e.g., 'productivity setups')..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  disabled={loading}
                  className="w-full bg-gray-50 border border-gray-200 text-gray-900 rounded-xl pl-12 pr-4 py-3.5 text-base md:text-lg focus:outline-none focus:ring-2 focus:ring-black focus:border-transparent transition-all disabled:opacity-50 font-medium"
                />
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
                <button 
                  type="submit" 
                  disabled={loading || !query.trim()}
                  className="absolute right-2 top-2 bottom-2 bg-black text-white px-6 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50"
                >
                  {loading ? 'Searching...' : 'Search'}
                </button>
              </div>
              
              <div className="border-t border-gray-100 pt-5 grid grid-cols-1 sm:grid-cols-3 gap-6">
                 <div>
                    <label className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                       <span>Min Subscribers</span>
                       <span className="text-gray-900 bg-gray-100 px-2 py-0.5 rounded-md">{minSubs.toLocaleString()}</span>
                    </label>
                    <input type="range" min="0" max="1000000" step="1000" value={minSubs} onChange={(e) => setMinSubs(Number(e.target.value))} className="w-full accent-black cursor-pointer" />
                 </div>
                 <div>
                    <label className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                       <span>Max Subscribers</span>
                       <span className="text-gray-900 bg-gray-100 px-2 py-0.5 rounded-md">{maxSubs >= 1000000 ? '1M+' : maxSubs.toLocaleString()}</span>
                    </label>
                    <input type="range" min="0" max="1000000" step="5000" value={maxSubs} onChange={(e) => setMaxSubs(Number(e.target.value))} className="w-full accent-black cursor-pointer" />
                 </div>
                 <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                       Upload Timeframe
                    </label>
                    <select 
                      value={timeframe} 
                      onChange={(e) => setTimeframe(Number(e.target.value))}
                      className="w-full bg-gray-50 border border-gray-200 text-gray-900 text-sm rounded-lg focus:ring-black focus:border-black block p-2"
                    >
                      <option value={7}>Last 7 Days</option>
                      <option value={30}>Last 30 Days</option>
                      <option value={90}>Last 90 Days</option>
                      <option value={180}>Last 180 Days</option>
                      <option value={365}>Last 365 Days</option>
                    </select>
                 </div>
              </div>

            </form>
          </div>

          {/* Loading State or Results */}
          {loading ? (
            <div className="w-full py-24 flex flex-col items-center justify-center gap-4 text-gray-500 bg-white rounded-2xl border border-gray-200 shadow-sm">
              <div className="w-8 h-8 rounded-full border-2 border-gray-300 border-t-black animate-spin" />
              <p className="text-sm font-medium">Scraping API for outliers... This takes a few seconds.</p>
            </div>
          ) : results.length > 0 ? (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
                <div className="flex items-center gap-3">
                   <div className="bg-[#E1F5EE] text-[#0F6E56] font-mono text-sm font-semibold px-3 py-1 rounded-md">
                     {results.length} Outliers Found
                   </div>
                   {activeSearchId && <span className="text-sm text-gray-500 font-medium">Viewing Historical Result</span>}
                </div>
                
                <button 
                  onClick={exportCSV}
                  className="flex items-center justify-center gap-2 bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 hover:text-black transition-colors"
                >
                  <Download size={16} /> Export to CSV
                </button>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {results.map((video, idx) => (
                  <a
                    key={`${video.video_id}-${idx}`}
                    href={`https://youtube.com/watch?v=${video.video_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex flex-col bg-white rounded-2xl overflow-hidden border border-gray-200 shadow-sm hover:shadow-md hover:border-gray-300 transition-all duration-200"
                  >
                    <div className="aspect-video w-full bg-gray-100 relative overflow-hidden">
                      <img 
                        src={video.thumbnail_url} 
                        alt="" 
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                        onError={(e) => {
                           // Fallback if hqdefault.jpg 404s
                           (e.target as HTMLImageElement).src = `https://img.youtube.com/vi/${video.video_id}/mqdefault.jpg`;
                        }}
                      />
                      <div className="absolute top-3 left-3 bg-white/90 backdrop-blur-md text-black font-mono text-xs font-bold px-2 py-1 rounded shadow-sm">
                        #{idx + 1}
                      </div>
                      <div className="absolute top-3 right-3 bg-black/85 backdrop-blur-sm text-white text-xs font-semibold px-2.5 py-1 rounded flex items-center gap-1.5 shadow-sm">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#1D9E75] animate-pulse"></span>
                        {video.outlier_ratio.toFixed(1)}x V/S
                      </div>
                    </div>
                    
                    <div className="p-4 flex flex-col flex-1">
                      <h3 className="font-semibold text-gray-900 text-sm leading-snug line-clamp-2 mb-2 group-hover:text-black underline-offset-2 group-hover:underline">
                        {video.title}
                      </h3>
                      <div className="flex items-center gap-2 mb-4 text-xs text-gray-500">
                        <Youtube size={14} className="text-red-500 shrink-0" />
                        <span className="truncate flex-1 font-medium">{video.channel_name}</span>
                        <span className="shrink-0">{new Date(video.published_at).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}</span>
                      </div>
                      
                      <div className="mt-auto grid grid-cols-2 gap-2 text-xs">
                        <div className="bg-gray-50 px-3 py-2.5 rounded-lg border border-gray-100 flex flex-col items-center">
                          <div className="text-gray-500 mb-0.5 font-medium">Views</div>
                          <div className="font-bold text-gray-900">{(video.views || 0).toLocaleString()}</div>
                        </div>
                        <div className="bg-gray-50 px-3 py-2.5 rounded-lg border border-gray-100 flex flex-col items-center">
                          <div className="text-gray-500 mb-0.5 font-medium">Subscribers</div>
                          <div className="font-bold text-gray-900">{(video.subscriber_count || 0).toLocaleString()}</div>
                        </div>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          ) : (
            activeSearchId === null && !loading && Array.isArray(results) && results.length === 0 && query && !error && (
              <div className="w-full py-24 flex flex-col items-center justify-center text-gray-400 bg-white rounded-2xl border border-gray-200 border-dashed">
                <SlidersHorizontal size={48} className="opacity-30 mb-4" />
                <p className="text-sm font-medium">No outliers matched these strict filters.</p>
                <p className="text-xs mt-1">Try expanding the subscriber range or extending the timeframe.</p>
              </div>
            )
          )}
        </main>
      </div>
    </div>
  );
}
