import { useState, useEffect, useRef } from 'react';
import { Flame, Moon, Sun, ChevronRight, Menu, X, ArrowUp, ExternalLink, RefreshCw, AlertCircle } from 'lucide-react';
import { db } from './firebase';
import { collection, query, orderBy, limit, onSnapshot, doc, getDoc, setDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { formatDistanceToNow } from 'date-fns';
import { tr } from 'date-fns/locale';

const RSS_SOURCES = [
  { name: "Habertürk", url: "https://www.haberturk.com/rss" },
  { name: "Sabah", url: "https://www.sabah.com.tr/rss/anasayfa.xml" },
  { name: "Sözcü", url: "https://www.sozcu.com.tr/rss/" },
  { name: "CNN Türk", url: "https://www.cnnturk.com/feed/rss/all/news" },
  { name: "Cumhuriyet", url: "https://www.cumhuriyet.com.tr/rss/son_dakika.xml" },
  { name: "Haber7", url: "https://rss.haber7.com/rss/manset.xml" },
  { name: "Star", url: "https://www.star.com.tr/rss/rss.asp" },
  { name: "Haberler.com", url: "https://rss.haberler.com/rss.asp" }
];

const CATEGORIES = ["Tümü", "Gündem", "Ekonomi", "Spor", "Teknoloji", "Dünya", "Sağlık"];

const PROXIES = [
  { name: "RSS2JSON", fn: (url) => `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}&nocache=${Date.now()}` },
  { name: "AllOrigins", fn: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}&_t=${Date.now()}` },
  { name: "CodeTabs", fn: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}` }
];

function App() {
  const [allNews, setAllNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeCategory, setActiveCategory] = useState("Tümü");
  const [darkMode, setDarkMode] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(40);
  const [lastSyncTs, setLastSyncTs] = useState(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
  
  const isRunning = useRef(false);
  const isDragging = useRef(false);
  const startX = useRef(0);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener('resize', handleResize);
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      setDarkMode(true);
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    const handleScroll = () => setShowScrollTop(window.scrollY > 400);
    window.addEventListener('scroll', handleScroll);
    if (isRunning.current) return;
    isRunning.current = true;
    startApp();
    const interval = setInterval(checkSyncInterval, 50000);
    return () => { clearInterval(interval); window.removeEventListener('scroll', handleScroll); window.removeEventListener('resize', handleResize); };
  }, []);

  const startApp = async () => {
    setLoading(true);
    const q = query(collection(db, "news"), orderBy("publishedAt", "desc"), limit(400));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setAllNews(mixWithDiversity(data));
      setLoading(false);
      if (snapshot.empty) loadSync();
    }, () => setLoading(false));
    checkSyncInterval();
    return () => unsubscribe();
  };

  const mixWithDiversity = (data) => {
    if (!data || data.length === 0) return [];
    const sorted = [...data].sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const result = [];
    const usedIds = new Set();
    const sources = [...new Set(sorted.map(n => n.source))];
    const grouped = sources.map(s => sorted.filter(n => n.source === s));
    for (let i = 0; i < 50; i++) {
      grouped.forEach(list => {
        if (list[i] && !usedIds.has(list[i].id)) {
          result.push(list[i]);
          usedIds.add(list[i].id);
        }
      });
    }
    const remainder = sorted.filter(s => !usedIds.has(s.id));
    return [...result, ...remainder];
  };

  const checkSyncInterval = async () => {
    try {
      const syncRef = doc(db, "settings", "lastSync");
      const syncDoc = await getDoc(syncRef);
      const now = Date.now();
      const lastTime = syncDoc.data()?.time?.toMillis?.() || 0;
      setLastSyncTs(lastTime);
      if (now - lastTime > 300000) loadSync();
    } catch (e) { loadSync(); }
  };

  const loadSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try { await setDoc(doc(db, "settings", "lastSync"), { time: serverTimestamp() }); } catch(e){}
    const allNewItems = [];
    for (const source of RSS_SOURCES) {
      let foundSource = false;
      for (const proxy of PROXIES) {
        if (foundSource) break;
        try {
          const res = await fetch(proxy.fn(source.url), { signal: AbortSignal.timeout(8000) });
          if (!res.ok) continue;
          if (proxy.name === "RSS2JSON") {
            const data = await res.json();
            if (data.status === 'ok') {
               const processed = data.items.map(item => parseItem(item, source.name));
               allNewItems.push(...processed.filter(it => it.publishedAt !== "N/A"));
               foundSource = true;
            }
          } else {
            let xml = (proxy.name === "AllOrigins") ? (await res.json()).contents : await res.text();
            if (xml && xml.includes("<item")) {
              const docParsed = new DOMParser().parseFromString(xml, "text/xml");
              const items = Array.from(docParsed.querySelectorAll("item, entry")).slice(0, 30);
              const processed = items.map(item => parseXmlItem(item, source.name)).filter(it => it.publishedAt !== "N/A");
              allNewItems.push(...processed);
              foundSource = true;
            }
          }
        } catch (e) { }
      }
    }
    if (allNewItems.length > 0) saveToFirestoreBatch(allNewItems);
    setSyncing(false);
  };

  const parseItem = (item, source) => {
    const rawDate = item.pubDate || item.published;
    const dateObj = rawDate ? new Date(rawDate) : null;
    return {
      title: (item.title || "").trim(),
      description: (item.description || "").substring(0, 180),
      url: item.link || item.url,
      image: item.enclosure?.link || item.thumbnail || "https://images.unsplash.com/photo-1585829365295-ab7cd400c167?auto=format&fit=crop&w=800&q=80",
      source: source,
      category: categorize((item.title || "")),
      publishedAt: (dateObj && !isNaN(dateObj)) ? dateObj.toISOString() : "N/A"
    };
  };

  const parseXmlItem = (item, source) => {
    const desc = item.querySelector("description, summary, content")?.textContent || "";
    let img = item.querySelector("enclosure")?.getAttribute("url") || item.querySelector("content[url]")?.getAttribute("url") || "";
    if (!img) { const m = desc.match(/<img[^>]+src="([^">]+)"/); if (m) img = m[1]; }
    const rawDate = item.querySelector("pubDate, published")?.textContent;
    const dateObj = rawDate ? new Date(rawDate) : null;
    return {
      title: (item.querySelector("title")?.textContent || "").trim(),
      description: desc.replace(/<[^>]*>?/gm, '').substring(0, 180).trim(),
      url: item.querySelector("link")?.textContent || item.querySelector("link")?.getAttribute("href") || "#",
      image: img || "https://images.unsplash.com/photo-1585829365295-ab7cd400c167?auto=format&fit=crop&w=800&q=80",
      source: source,
      category: categorize((item.querySelector("title")?.textContent || "")),
      publishedAt: (dateObj && !isNaN(dateObj)) ? dateObj.toISOString() : "N/A"
    };
  };

  const categorize = (text) => {
    const low = text.toLowerCase();
    if (low.match(/dolar|euro|faiz|altın|borsa|ekonomi|banka|emekli|maaş|zam/)) return "Ekonomi";
    if (low.match(/maç|futbol|gol|transfer|derbi|spor|basketbol|voleybol/)) return "Spor";
    if (low.match(/iphone|android|teknoloji|yapay zeka|ai|yazılım|dijital/)) return "Teknoloji";
    if (low.match(/dünya|dış haber|abd|rusya|ukrayna|avrupa|asya|israil/)) return "Dünya";
    if (low.match(/sağlık|doktor|hastane|tedavi|ilaç|ameliyat|virüs|kalp/)) return "Sağlık";
    return "Gündem";
  }

  const saveToFirestoreBatch = async (items) => {
    try {
      const batch = writeBatch(db);
      items.filter(it => it.url && it.url !== "#" && it.publishedAt !== "N/A").forEach(item => {
        const id = btoa(unescape(encodeURIComponent(item.url))).substring(0, 150).replace(/\//g, '_');
        batch.set(doc(db, "news", id), { ...item, updatedAt: serverTimestamp() }, { merge: true });
      });
      await batch.commit();
    } catch (e) { }
  };

  const filteredNews = activeCategory === "Tümü" ? allNews : allNews.filter(n => n.category === activeCategory);
  const sliderLimit = isMobile ? 8 : 20; 
  const sliderHaberler = filteredNews.slice(0, sliderLimit);
  const gridHaberler = filteredNews.slice(sliderLimit, visibleCount + sliderLimit);

  const onHandleStart = (e) => { isDragging.current = true; startX.current = e.pageX || e.touches[0].pageX; };
  const onHandleEnd = (e) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const endX = e.pageX || e.changedTouches[0].pageX;
    const diff = startX.current - endX;
    if (Math.abs(diff) > 50) {
      if (diff > 0) setCurrentSlide(p => (p === sliderHaberler.length - 1 ? 0 : p + 1));
      else setCurrentSlide(p => (p === 0 ? sliderHaberler.length - 1 : p - 1));
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <button className="mobile-menu-btn" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}><Menu/></button>
          <div className="brand" onClick={() => window.location.reload()}><Flame className="brand-icon" size={28} /><span>Bilgin Haber</span></div>
        </div>
        <nav className={`header-center ${isMobileMenuOpen ? 'mobile-open' : ''}`}>
          {isMobileMenuOpen && <div className="mobile-nav-header"><Flame size={24}/><span>Kategoriler</span><button onClick={()=>setIsMobileMenuOpen(false)}><X/></button></div>}
          {CATEGORIES.map(cat => (
            <button key={cat} className={`nav-link ${activeCategory === cat ? 'active' : ''}`} onClick={() => {setActiveCategory(cat); setVisibleCount(40); setCurrentSlide(0); window.scrollTo({top:0, behavior:'smooth'}); setIsMobileMenuOpen(false);}}>{cat}</button>
          ))}
        </nav>
        <div className="header-right">
           <button className="icon-btn refresh-trigger" onClick={loadSync} disabled={syncing} title="Hemen Tazele"><RefreshCw size={20} className={syncing ? "spin" : ""} /></button>
           <button className="icon-btn" onClick={() => {
            const m = !darkMode; setDarkMode(m);
            document.documentElement.setAttribute('data-theme', m ? 'dark' : 'light');
            localStorage.setItem('theme', m ? 'dark' : 'light');
           }} title="Tema Değiştir">{darkMode ? <Sun/> : <Moon/>}</button>
        </div>
      </header>

      <main className="main-container">
        {loading ? (
             <div className="loading-container"><div className="spinner"></div><p style={{marginTop:'1.5rem'}}>Haber Akışı Hazırlanıyor...</p></div>
        ) : (
          <div className="fade-in">
             <div className="sync-info-row">
                <div className={`status-pill ${syncing ? 'syncing' : ''}`}>
                   {syncing ? <RefreshCw size={14} className="spin"/> : <AlertCircle size={14}/>}
                   {syncing ? 'Tazeleniyor...' : lastSyncTs ? `Güncellendi: ${formatDistanceToNow(lastSyncTs, { addSuffix: true, locale: tr })}` : 'Canlı Akış'}
                </div>
                <div className="sort-label">🔄 Zengin Haber Akışı</div>
             </div>
             
             {sliderHaberler.length > 0 && (
               <section className="hero-grid-wrapper">
                  <div className="slider-main" onMouseDown={onHandleStart} onMouseUp={onHandleEnd} onTouchStart={onHandleStart} onTouchEnd={onHandleEnd}>
                    <div className="slider-track" style={{ transform: `translateX(-${currentSlide * 100}%)` }}>
                      {sliderHaberler.map((item, index) => (
                        <div key={item.id || index} className="slide">
                          <a href={item.url} target="_blank" rel="noopener noreferrer" className="slide-link">
                            <img src={item.image} alt={item.title} className="slide-img" draggable="false" onError={(e) => { e.target.onerror = null; e.target.src="https://images.unsplash.com/photo-1585829365295-ab7cd400c167?auto=format&fit=crop&w=800&q=80"; }} />
                            <div className="slide-content">
                               <div className="slide-meta"><span className="source-tag">{item.source}</span><span className="time-tag">{formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true, locale: tr })}</span></div>
                               <h2 className="slide-title">{item.title}</h2>
                            </div>
                          </a>
                        </div>
                      ))}
                    </div>
                    <div className="slider-numbers-container">
                       <div className="num-scroll-helper">
                          {sliderHaberler.map((_, idx) => (
                            <button key={idx} className={`slider-num-btn ${currentSlide === idx ? 'active' : ''}`} onClick={() => setCurrentSlide(idx)}>{idx + 1}</button>
                          ))}
                       </div>
                    </div>
                  </div>
                  
                  <aside className="slider-aside">
                     {sliderHaberler.slice(0, 6).map((item, idx) => (
                       <div key={idx} className={`aside-card ${currentSlide === idx ? 'active' : ''}`} onClick={() => setCurrentSlide(idx)}>
                          <span className="aside-num">{idx + 1}</span>
                          <div className="aside-info">
                             <p className="aside-source">{item.source} • {formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true, locale: tr })}</p>
                             <h3 className="aside-title">{item.title}</h3>
                          </div>
                       </div>
                     ))}
                  </aside>
               </section>
             )}

             <section className="main-grid-section">
                <h2 className="grid-header">En Yeni Gelişmeler</h2>
                <div className="news-grid">
                   {gridHaberler.map((item, idx) => (
                     <article key={item.id || idx} className="news-card">
                        <div className="card-media">
                          <a href={item.url} target="_blank" rel="noopener noreferrer">
                             <img src={item.image} alt={item.title} className="card-img" onError={(e) => { e.target.onerror = null; e.target.src="https://images.unsplash.com/photo-1585829365295-ab7cd400c167?auto=format&fit=crop&w=800&q=80"; }} />
                          </a>
                          <span className="card-badge">{item.source}</span>
                        </div>
                        <div className="card-body">
                          <div className="card-top">
                             <span className="card-cat">{item.category}</span>
                             <span className="card-sep">•</span>
                             <span className="card-time">{formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true, locale: tr })}</span>
                          </div>
                          <h2 className="card-title">{item.title}</h2>
                          <div className="card-footer">
                             <a href={item.url} target="_blank" rel="noopener noreferrer" className="btn-read">Habere Git <ExternalLink size={14}/></a>
                          </div>
                        </div>
                     </article>
                   ))}
                </div>
                {visibleCount < filteredNews.length && (
                   <div className="load-more-center"><button className="btn-more" onClick={() => setVisibleCount(p => p + 15)}> Daha Fazla Haber </button></div>
                )}
             </section>
          </div>
        )}
      </main>

      <button className={`scroll-to-top ${showScrollTop ? 'visible' : ''}`} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><ArrowUp size={24}/></button>
      <footer className="app-footer"><div className="footer-content"><Flame size={20}/> <span>Bilgin Haber © 2026 - Tüm Hakları Saklıdır</span></div></footer>

      <style>{`
        :root {
          --primary: #ff3b30; --primary-dark: #d70015; --bg-main: #f8f9fa; --card-bg: #ffffff;
          --text-main: #1d1d1f; --text-secondary: #86868b; --border-color: #e5e5e5;
          --header-bg: rgba(255, 255, 255, 0.85); --shadow-sm: 0 4px 15px rgba(0,0,0,0.05);
          --shadow-md: 0 12px 40px rgba(0,0,0,0.12);
        }
        [data-theme='dark'] {
          --bg-main: #000000; --card-bg: #1c1c1e; --text-main: #f5f5f7;
          --text-secondary: #a1a1a6; --border-color: #38383a; --header-bg: rgba(18, 18, 18, 0.85);
        }

        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg-main); color: var(--text-main); transition: 0.3s; overflow-x: hidden; touch-action: pan-y; }
        
        /* HEADER & NAVIGATION */
        .app-header { position: sticky; top: 0; z-index: 1000; height: 75px; display: flex; align-items: center; justify-content: space-between; padding: 0 5%; background: var(--header-bg); backdrop-filter: saturate(180%) blur(25px); border-bottom: 1px solid var(--border-color); }
        .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 1.5rem; color: var(--primary); cursor: pointer; }
        .header-center { display: flex; gap: 15px; }
        .nav-link { background: none; border: none; color: var(--text-secondary); font-weight: 700; cursor: pointer; transition: 0.3s; padding: 8px 12px; }
        .nav-link.active { color: var(--primary); }
        .mobile-menu-btn { display: none; background: none; border: none; color: var(--text-main); cursor: pointer; }

        /* PILLS & STATUS */
        .sync-info-row { display: flex; justify-content: space-between; align-items: center; margin: 1.5rem 0 2rem; }
        .status-pill, .sort-label { display: flex; align-items: center; gap: 10px; font-size: 0.85rem; font-weight: 900; background: var(--card-bg); padding: 10px 22px; border-radius: 40px; border: 1px solid var(--border-color); color: var(--text-secondary); box-shadow: var(--shadow-sm); }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 2s linear infinite; }

        .main-container { max-width: 1400px; margin: 0 auto; padding: 0 5% 5rem; }
        
        /* HERO AREA - STABLE */
        .hero-grid-wrapper { display: grid; grid-template-columns: 2.5fr 1fr; gap: 24px; height: 500px; margin-bottom: 4.5rem; position: relative; z-index: 20; }
        .slider-main { position: relative; border-radius: 28px; overflow: hidden; background: #000; box-shadow: var(--shadow-md); height: 100%; cursor: grab; }
        .slider-track { display: flex; height: 100%; transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1); pointer-events: none; }
        .slide { flex: 0 0 100%; height: 100%; position: relative; pointer-events: auto; }
        .slide-img { width: 100%; height: 100%; object-fit: cover; opacity: 0.8; -webkit-user-drag: none; }
        .slide-content { position: absolute; bottom: 0; left: 0; width: 100%; padding: 120px 45px 85px; background: linear-gradient(transparent, rgba(0,0,0,0.95)); color: white; pointer-events: none; }
        .slide-title { font-size: 2.1rem; font-weight: 900; line-height: 1.2; margin: 0; }

        .slider-numbers-container { position: absolute; bottom: 25px; left: 50%; transform: translateX(-50%); z-index: 100; background: rgba(0,0,0,0.6); padding: 8px 15px; border-radius: 50px; backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.15); }
        .num-scroll-helper { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; }
        .slider-num-btn { background: rgba(255,255,255,0.25); color: white; border: none; min-width: 32px; height: 32px; border-radius: 50%; font-size: 0.9rem; font-weight: 900; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; transition: 0.2s; }
        .slider-num-btn.active { background: var(--primary); transform: scale(1.1); }

        .slider-aside { display: flex; flex-direction: column; gap: 12px; height: 100%; overflow-y: auto; scrollbar-width: none; }
        .aside-card { display: flex; gap: 15px; padding: 16px; border-radius: 20px; background: var(--card-bg); cursor: pointer; border: 1px solid var(--border-color); transition: 0.3s; }
        .aside-card.active { border-color: var(--primary); background: rgba(255, 59, 48, 0.05); }

        /* GRID & CARDS - BUTTON FIX */
        .main-grid-section { position: relative; z-index: 10; padding-top: 1rem; clear: both; }
        .news-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 30px; }
        .news-card { background: var(--card-bg); border-radius: 28px; overflow: hidden; border: 1px solid var(--border-color); display: flex; flex-direction: column; transition: 0.3s; box-shadow: var(--shadow-sm); }
        .card-media { height: 220px; position: relative; overflow: hidden; }
        .card-badge { position: absolute; top: 15px; right: 15px; background: var(--primary); color: white; padding: 6px 12px; border-radius: 10px; font-size: 0.75rem; font-weight: 900; z-index: 10; }
        .card-body { padding: 25px; flex-grow: 1; display: flex; flex-direction: column; }
        .card-title { font-size: 1.25rem; font-weight: 800; line-height: 1.4; color: var(--text-main); margin-bottom: 25px; }
        
        /* PREMIUM HABERE GİT BUTTON */
        .card-footer { margin-top: auto; padding-top: 15px; border-top: 1px solid var(--border-color); }
        .btn-read { display: flex; align-items: center; justify-content: center; gap: 8px; background: var(--primary); color: white; padding: 12px 20px; border-radius: 15px; font-weight: 800; text-decoration: none; transition: 0.3s; border: none; cursor: pointer; }
        .btn-read:hover { background: var(--primary-dark); transform: translateY(-2px); box-shadow: 0 5px 15px rgba(255, 59, 48, 0.3); }

        /* MISC */
        .scroll-to-top { position: fixed; bottom: 40px; right: 40px; background: var(--primary); color: white; width: 60px; height: 60px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; opacity: 0; visibility: hidden; transition: 0.4s; z-index: 1500; cursor: pointer; box-shadow: 0 10px 30px rgba(255, 59, 48, 0.4); }
        .scroll-to-top.visible { opacity: 1; visibility: visible; }
        
        @media (max-width: 1024px) {
          .mobile-menu-btn { display: block; }
          .header-center { position: fixed; top: 0; left: -105%; width: 280px; height: 100vh; background: var(--card-bg); flex-direction: column; align-items: flex-start; padding: 25px; transition: 0.4s cubic-bezier(0.16, 1, 0.3, 1); z-index: 2000; box-shadow: 20px 0 50px rgba(0,0,0,0.2); }
          .header-center.mobile-open { left: 0; }
          .news-grid { grid-template-columns: repeat(2, 1fr); }
          .hero-grid-wrapper { grid-template-columns: 1fr; height: auto; margin-bottom: 2rem; }
          .slider-main { height: 380px; }
          .slider-aside { display: none; }
        }
        @media (max-width: 600px) {
          .slider-main { height: 320px; }
        }
      `}</style>
    </div>
  );
}

export default App;
