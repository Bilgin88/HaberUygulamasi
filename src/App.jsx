import { useState, useEffect, useRef } from 'react';
import { Flame, Moon, Sun, ChevronRight, Menu, X, ArrowDown, ExternalLink, RefreshCw, AlertCircle } from 'lucide-react';
import { db } from './firebase';
import { collection, query, orderBy, limit, onSnapshot, doc, getDoc, setDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { formatDistanceToNow } from 'date-fns';
import { tr } from 'date-fns/locale';

const RSS_SOURCES = [
  { name: "Habertürk", url: "https://www.haberturk.com/rss" },
  { name: "Sabah", url: "https://www.sabah.com.tr/rss/anasayfa.xml" },
  { name: "Sözcü", url: "https://www.sozcu.com.tr/rss" },
  { name: "CNN Türk", url: "https://www.cnnturk.com/feed/rss/all/news" },
  { name: "Cumhuriyet", url: "https://www.cumhuriyet.com.tr/rss/1.xml" },
  { name: "Haber7", url: "https://rss.haber7.com/rss.xml" },
  { name: "Star", url: "https://www.star.com.tr/rss/rss.asp" },
  { name: "Haberler.com", url: "https://rss.haberler.com/rss.asp" }
];

const CATEGORIES = ["Tümü", "Gündem", "Ekonomi", "Spor", "Teknoloji", "Dünya", "Sağlık"];

const PROXIES = [
  { name: "RSS2JSON", fn: (url) => `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}` },
  { name: "CodeTabs", fn: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}` },
  { name: "AllOrigins", fn: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}&t=${Date.now()}` }
];

function App() {
  const [allNews, setAllNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeCategory, setActiveCategory] = useState("Tümü");
  const [darkMode, setDarkMode] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(24);
  const [retryShow, setRetryShow] = useState(false);
  
  const isRunning = useRef(false);

  useEffect(() => {
    if (localStorage.getItem('theme') === 'dark') {
      setDarkMode(true);
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    if (isRunning.current) return;
    isRunning.current = true;
    startApp();
  }, []);

  const startApp = async () => {
    setLoading(true);
    const q = query(collection(db, "news"), orderBy("publishedAt", "desc"), limit(200));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setAllNews(mixEverything(data));
        setLoading(false); // Veri geldiği an yükleme ekranını kapat
      }
    });

    // 7 saniye sonra hala yükleme ekranındaysak butonu göster
    setTimeout(() => { if (allNews.length === 0) setRetryShow(true); }, 7000);

    checkSyncInterval();
    return () => unsubscribe();
  };

  const checkSyncInterval = async () => {
    try {
      const syncDoc = await getDoc(doc(db, "settings", "lastSync"));
      if (!syncDoc.exists() || (Date.now() - syncDoc.data().time.toMillis() > 300000)) {
        loadSync();
      }
    } catch (e) {
      if (allNews.length === 0) loadSync();
    }
  };

  const loadSync = async () => {
    if (syncing) return;
    setSyncing(true);
    
    for (const source of RSS_SOURCES) {
      let found = false;
      for (const proxy of PROXIES) {
        if (found) break;
        try {
          // --- KESİN ZAMAN AŞIMI (Timeout) ---
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), 5000); // 5 saniye sınırı

          const res = await fetch(proxy.fn(source.url), { signal: controller.signal });
          clearTimeout(tid);

          if (proxy.name === "RSS2JSON") {
            const data = await res.json();
            if (data.status === 'ok') {
               const processed = data.items.map(item => ({
                  title: item.title,
                  description: item.description.replace(/<[^>]*>?/gm, '').substring(0, 180),
                  url: item.link,
                  image: item.enclosure?.link || item.thumbnail || "https://images.unsplash.com/photo-1585829365295-ab7cd400c167?auto=format&fit=crop&w=800&q=80",
                  source: source.name,
                  category: categorize(item.title + item.description),
                  publishedAt: item.pubDate
               }));
               setAllNews(prev => mixEverything([...prev, ...processed]));
               setLoading(false); // İlk haber gelince yüklemeyi bitir
               saveToFirestore(processed);
               found = true;
            }
            continue;
          }

          let xml = (proxy.name === "AllOrigins") ? (await res.json()).contents : await res.text();
          if (xml && xml.includes("<item")) {
            const docParsed = new DOMParser().parseFromString(xml, "text/xml");
            const items = Array.from(docParsed.querySelectorAll("item, entry")).slice(0, 20);
            if (items.length > 0) {
              const processed = processRawItems(items, source.name);
              setAllNews(prev => mixEverything([...prev, ...processed]));
              setLoading(false);
              saveToFirestore(processed);
              found = true;
            }
          }
        } catch (e) { continue; }
      }
    }
    setSyncing(false);
    try { await setDoc(doc(db, "settings", "lastSync"), { time: serverTimestamp() }); } catch (e) {}
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

  const saveToFirestore = async (items) => {
    try {
      const batch = writeBatch(db);
      items.forEach(item => {
        const id = btoa(unescape(encodeURIComponent(item.url))).substring(0, 150).replace(/\//g, '_');
        batch.set(doc(db, "news", id), { ...item, createdAt: serverTimestamp() }, { merge: true });
      });
      await batch.commit();
    } catch (e) {}
  };

  const processRawItems = (items, sourceName) => {
    return items.map(item => {
      const title = item.querySelector("title")?.textContent || "";
      const link = item.querySelector("link")?.textContent || item.querySelector("link")?.getAttribute("href") || "#";
      const rawContent = item.querySelector("description, summary, content")?.textContent || "";
      
      let img = "";
      const enclosure = item.querySelector("enclosure");
      const mediaContent = item.querySelector("content[url], thumbnail[url]");
      if (enclosure) img = enclosure.getAttribute("url");
      else if (mediaContent) img = mediaContent.getAttribute("url");
      else {
        const m = rawContent.match(/<img[^>]+src="([^">]+)"/);
        if (m) img = m[1];
      }

      let desc = rawContent.replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ').trim();
      if (desc.length < 20) desc = `${title}. Detaylar için tıklayınız.`;

      return {
        title: title.trim(), description: desc.substring(0, 180), url: link,
        image: img || "https://images.unsplash.com/photo-1585829365295-ab7cd400c167?auto=format&fit=crop&w=800&q=80",
        source: sourceName, category: categorize(title + " " + desc),
        publishedAt: item.querySelector("pubDate, published")?.textContent || new Date().toISOString()
      };
    });
  };

  const mixEverything = (data) => {
    const unique = data.filter((v, i, a) => a.findIndex(t => t.url === v.url) === i);
    const sources = [...new Set(unique.map(n => n.source))];
    const grouped = sources.map(s => unique.filter(n => n.source === s));
    const interleaved = [];
    for (let i = 0; i < 50; i++) {
        grouped.forEach(list => { if (list[i]) interleaved.push(list[i]); });
    }
    return interleaved;
  };

  const filteredNews = activeCategory === "Tümü" ? allNews : allNews.filter(n => n.category === activeCategory);
  const sliderHaberler = filteredNews.slice(0, 20);
  const gridHaberler = filteredNews.slice(20, visibleCount + 20);

  useEffect(() => {
    if (sliderHaberler.length > 0) {
      const timer = setInterval(() => setCurrentSlide(p => (p === sliderHaberler.length - 1 ? 0 : p + 1)), 6000);
      return () => clearInterval(timer);
    }
  }, [sliderHaberler.length]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <button className="mobile-menu-btn" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}>{isMobileMenuOpen ? <X/> : <Menu/>}</button>
          <div className="brand"><Flame className="brand-icon" size={28} /><span>Bilgin Haber</span></div>
        </div>
        <nav className="header-center">
          {CATEGORIES.map(cat => (
            <button key={cat} className={`nav-link ${activeCategory === cat ? 'active' : ''}`} onClick={() => {setActiveCategory(cat); setVisibleCount(24); setCurrentSlide(0);}}>{cat}</button>
          ))}
        </nav>
        <button className="icon-btn" onClick={() => {
          const m = !darkMode; setDarkMode(m);
          document.documentElement.setAttribute('data-theme', m ? 'dark':'light');
          localStorage.setItem('theme', m ? 'dark':'light');
        }}>{darkMode ? <Sun/> : <Moon/>}</button>
      </header>
      {isMobileMenuOpen && (
        <div className="mobile-nav open">
          {CATEGORIES.map(cat => (
             <button key={cat} className="nav-link" onClick={() => {setActiveCategory(cat); setIsMobileMenuOpen(false);}}>{cat}</button>
          ))}
        </div>
      )}
      <main className="main-container">
        {loading && allNews.length === 0 ? (
             <div className="loading-container" style={{padding:'20vh 1rem', textAlign:'center'}}>
                {retryShow ? (
                  <div className="fade-in">
                    <AlertCircle size={48} color="var(--primary)" style={{marginBottom:'1.5rem'}}/>
                    <h3>Habertürk ve Diğerleri Taranıyor...</h3>
                    <p style={{marginTop:'1rem', opacity:0.7}}>Bağlantı biraz yavaş, lütfen bekleyin veya butona basın.</p>
                    <button onClick={() => setLoading(false)} className="load-more-btn" style={{marginTop:'2rem'}}>Sistemi Şimdi Aç</button>
                  </div>
                ) : (
                  <>
                    <div className="spinner"></div>
                    <p style={{marginTop:'1.5rem'}}>Bilgin Haber Hazırlanıyor...</p>
                  </>
                )}
             </div>
        ) : (
          <div className="fade-in">
             {sliderHaberler.length > 0 && (
               <section className="hero-wrapper">
                  <div className="slider-container">
                    <div className="slider-track" style={{ transform: `translateX(-${currentSlide * 100}%)` }}>
                      {sliderHaberler.map((item, index) => (
                        <div key={item.url || index} className="slide">
                          <a href={item.url} target="_blank" rel="noopener noreferrer" className="slide-link">
                            <img src={item.image} alt={item.title} className="slide-img" />
                            <div className="slide-content">
                              <span className="slide-badge">{index + 1} / {sliderHaberler.length} • {item.source}</span>
                              <h2 className="slide-title">{item.title}</h2>
                            </div>
                          </a>
                        </div>
                      ))}
                    </div>
                    <button className="slider-nav-btn prev" onClick={() => setCurrentSlide(p => p===0 ? sliderHaberler.length-1 : p-1)}><ChevronRight style={{transform:'rotate(180deg)'}}/></button>
                    <button className="slider-nav-btn next" onClick={() => setCurrentSlide(p => p===sliderHaberler.length-1 ? 0 : p+1)}><ChevronRight/></button>
                    <div className="slider-dots" style={{ display: 'flex', flexWrap: 'nowrap', overflowX: 'auto', maxWidth: '90%', gap: '8px', bottom: '15px', padding: '5px 10px', msOverflowStyle: 'none', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
                       {sliderHaberler.map((_, idx) => (
                        <div key={idx} className={`dot ${currentSlide === idx ? 'active' : ''}`} onClick={() => setCurrentSlide(idx)}
                          style={{ width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 'bold', color: 'white', border: '1px solid rgba(255,255,255,0.2)', background: currentSlide === idx ? 'var(--primary)' : 'rgba(0,0,0,0.5)', borderRadius: '4px', cursor: 'pointer' }}
                        >{idx + 1}</div>
                      ))}
                    </div>
                  </div>
                  <div className="slider-side-list">
                    {sliderHaberler.map((item, idx) => (
                       <div key={(item.url || '') + idx} className={`side-item ${currentSlide === idx ? 'active' : ''}`} onClick={() => setCurrentSlide(idx)}>
                          <span className="side-item-source">{idx + 1}. {item.source}</span>
                          <h3 className="side-item-title">{item.title}</h3>
                       </div>
                    ))}
                  </div>
               </section>
             )}
             <section style={{marginTop:'4rem'}}>
                <h2 className="grid-header">📰 {activeCategory.toUpperCase()} HABERLERİ</h2>
                <div className="news-grid">
                   {gridHaberler.map(item => (
                     <article key={item.url} className="news-card">
                        <a href={item.url} target="_blank" rel="noopener noreferrer" className="card-img-wrapper">
                          <img src={item.image} alt={item.title} className="card-img" />
                          <span className="card-source-tag">{item.source}</span>
                        </a>
                        <div className="card-content">
                          <div className="card-meta"><span>{item.category}</span><span>{item.publishedAt ? formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true, locale: tr }) : ''}</span></div>
                          <h2 className="card-title">{item.title}</h2>
                          <p className="card-desc">{item.description}</p>
                          <div className="card-footer"><a href={item.url} target="_blank" rel="noopener noreferrer" className="read-more">Devamı <ExternalLink size={16}/></a></div>
                        </div>
                     </article>
                   ))}
                </div>
                {visibleCount < filteredNews.length && (
                   <div className="load-more-container"><button className="load-more-btn" onClick={() => setVisibleCount(p => p + 12)}> Daha Fazla </button></div>
                )}
             </section>
          </div>
        )}
      </main>
      <footer className="app-footer"><p>© 2026 Bilgin Haber - Ultra Hızlı Sync</p></footer>
    </div>
  );
}

export default App;
