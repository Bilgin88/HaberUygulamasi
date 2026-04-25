import { useState, useEffect, useRef, useCallback } from 'react';
import { Flame, Moon, Sun, Menu, X, ArrowUp, ExternalLink, RefreshCw, AlertCircle } from 'lucide-react';
import { db } from './firebase';
import { collection, query, orderBy, limit, onSnapshot, doc, getDoc, setDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { formatDistanceToNow } from 'date-fns';
import { tr } from 'date-fns/locale';

const CATEGORIES = [
  "T\u00fcm\u00fc",
  "G\u00fcndem",
  "Ekonomi",
  "Spor",
  "Teknoloji",
  "D\u00fcnya",
  "Sa\u011fl\u0131k",
];
const FALLBACK_IMAGE = "https://images.unsplash.com/photo-1585829365295-ab7cd400c167?auto=format&fit=crop&w=800&q=80";
const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const STALE_SYNC_MS = 15 * 60 * 1000;
const FIRESTORE_QUERY_LIMIT = 1500;
const MAX_ITEMS_PER_SOURCE = 40;
const RSS_SOURCES = [
  { name: "Haberturk", url: "https://www.haberturk.com/rss/manset.xml" },
  { name: "Hurriyet", url: "https://www.hurriyet.com.tr/rss/anasayfa" },
  { name: "Sabah", url: "https://www.sabah.com.tr/rss/anasayfa.xml" },
  { name: "CNN Turk", url: "https://www.cnnturk.com/feed/rss/all/news" },
  { name: "Cumhuriyet", url: "https://www.cumhuriyet.com.tr/rss/son_dakika.xml" },
  { name: "Star", url: "https://www.star.com.tr/rss/rss.asp" },
  { name: "Sozcu", url: "https://www.sozcu.com.tr/rss/" },
  { name: "NTV", url: "https://www.ntv.com.tr/son-dakika.rss" },
  { name: "Haberler.com", url: "https://rss.haberler.com/rss.asp" },
];
const PROXIES = [
  { name: "RSS2JSON", fn: (url) => `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}&nocache=${Date.now()}` },
  { name: "AllOrigins", fn: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}&_t=${Date.now()}` },
  { name: "CodeTabs", fn: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}` },
];

const decodeHtmlEntities = (value = "") => {
  if (!value || typeof document === "undefined") return value || "";
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
};

const normalizeText = (value = "") =>
  decodeHtmlEntities(String(value))
    .replace(/\s+/g, " ")
    .trim();

const normalizeSourceName = (value = "") => {
  const normalized = normalizeText(value);
  if (normalized === "CNN Türk") return "CNN Turk";
  if (normalized === "Hürriyet") return "Hurriyet";
  if (normalized === "Sözcü") return "Sozcu";
  if (normalized === "CNN Türk") return "CNN Turk";
  if (normalized === "Habertürk") return "Haberturk";
  if (normalized === "Hürriyet") return "Hurriyet";
  if (normalized === "Sözcü") return "Sozcu";
  return normalized;
};

const normalizeNewsItem = (item) => ({
  ...item,
  title: normalizeText(item.title),
  description: normalizeText(item.description),
  source: normalizeSourceName(item.source),
  category: normalizeText(item.category),
});

const getPublishedDate = (value) => {
  if (!value) return null;
  if (value?.toDate && typeof value.toDate === "function") return value.toDate();
  if (typeof value?.seconds === "number") return new Date(value.seconds * 1000);

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getEffectivePublishedDate = (value) => {
  const date = getPublishedDate(value);
  if (!date) return null;

  const now = Date.now();
  const timestamp = date.getTime();

  if (timestamp > now + FUTURE_TOLERANCE_MS) {
    return new Date(0);
  }

  if (timestamp > now) {
    return new Date(now);
  }

  return date;
};

const getPublishedTime = (value) => {
  const date = getEffectivePublishedDate(value);
  return date ? date.getTime() : 0;
};

const formatPublishedDistance = (value) => {
  const originalDate = getPublishedDate(value);
  if (!originalDate) return "Tarih yok";

  if (originalDate.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
    return "Az \u00f6nce";
  }

  const date = getEffectivePublishedDate(value);
  return date ? formatDistanceToNow(date, { addSuffix: true, locale: tr }) : "Tarih yok";
};

const sortNewsByDate = (items = []) =>
  [...items].sort((a, b) => getPublishedTime(b.publishedAt) - getPublishedTime(a.publishedAt));

const isValidPublishedAt = (value) => {
  const date = getPublishedDate(value);
  return Boolean(date && date.getTime() <= Date.now() + 10 * 60 * 1000);
};

const mergeSourceItems = (items = []) => {
  const seen = new Map();

  for (const item of items) {
    if (!item?.url || item.url === "#" || item.publishedAt === "N/A") continue;

    const existing = seen.get(item.url);
    if (!existing || getPublishedTime(item.publishedAt) > getPublishedTime(existing.publishedAt)) {
      seen.set(item.url, item);
    }
  }

  return sortNewsByDate(Array.from(seen.values()));
};

const balanceNewsBySource = (items = []) => {
  const groups = new Map();

  for (const item of sortNewsByDate(items)) {
    const source = normalizeSourceName(item.source || "Bilinmeyen");
    const bucket = groups.get(source) || [];
    if (bucket.length >= MAX_ITEMS_PER_SOURCE) continue;
    bucket.push({ ...item, source });
    groups.set(source, bucket);
  }

  return sortNewsByDate(Array.from(groups.values()).flat());
};

const buildSliderNews = (items = [], limitCount = 20) => {
  const sortedItems = sortNewsByDate(items);
  const bySource = new Map();

  for (const item of sortedItems) {
    const source = normalizeSourceName(item.source || "Bilinmeyen");
    const bucket = bySource.get(source) || [];
    bucket.push({ ...item, source });
    bySource.set(source, bucket);
  }

  const sliderItems = [];
  const seenUrls = new Set();

  const firstPass = Array.from(bySource.values())
    .map((bucket) => bucket[0])
    .filter(Boolean)
    .sort((a, b) => getPublishedTime(b.publishedAt) - getPublishedTime(a.publishedAt));

  for (const item of firstPass) {
    if (sliderItems.length >= limitCount) break;
    if (seenUrls.has(item.url)) continue;
    sliderItems.push(item);
    seenUrls.add(item.url);
  }

  if (sliderItems.length < limitCount) {
    for (const item of sortedItems) {
      if (sliderItems.length >= limitCount) break;
      if (seenUrls.has(item.url)) continue;
      sliderItems.push(item);
      seenUrls.add(item.url);
    }
  }

  return sliderItems;
};

function App() {
  const [allNews, setAllNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeCategory, setActiveCategory] = useState("T\u00fcm\u00fc");
  const [darkMode, setDarkMode] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(40);
  const [lastSyncTs, setLastSyncTs] = useState(null);
  const [syncMessage, setSyncMessage] = useState("");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);

  const isRunning = useRef(false);
  const syncInFlight = useRef(false);
  const isDragging = useRef(false);
  const startX = useRef(0);

  const refreshSyncStatus = useCallback(async () => {
    try {
      const syncRef = doc(db, "settings", "lastSync");
      const syncDoc = await getDoc(syncRef);
      const lastTime = syncDoc.data()?.time?.toMillis?.() || 0;
      setLastSyncTs(lastTime || null);
      return lastTime || null;
    } catch {
      setLastSyncTs(null);
      return null;
    }
  }, []);

  const categorize = useCallback((text) => {
    const low = text.toLowerCase();
    if (low.match(/dolar|euro|faiz|altin|borsa|ekonomi|banka|emekli|maas|zam/)) return "Ekonomi";
    if (low.match(/mac|futbol|gol|transfer|derbi|spor|basketbol|voleybol/)) return "Spor";
    if (low.match(/iphone|android|teknoloji|yapay zeka|ai|yazilim|dijital/)) return "Teknoloji";
    if (low.match(/dunya|dis haber|abd|rusya|ukrayna|avrupa|asya|israil/)) return "Dunya";
    if (low.match(/saglik|doktor|hastane|tedavi|ilac|ameliyat|virus|kalp/)) return "Saglik";
    return "Gundem";
  }, []);

  const parseMarkdownFeed = useCallback((markdown = "", source) => {
    const entries = [];
    const pattern = /###\s+\[(.+?)\]\((https?:\/\/[^\s)]+)\)\s+([\s\S]*?)\n(?:\[https?:\/\/[^\]]+\]\([^)]+\)\s+)?([A-Za-z]{3},\s+\d{2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/g;
    let match;

    while ((match = pattern.exec(markdown)) !== null) {
      const [, title, url, body, rawDate] = match;
      const dateObj = new Date(rawDate);
      entries.push({
        title: normalizeText(title),
        description: normalizeText(body).substring(0, 180),
        url,
        image: FALLBACK_IMAGE,
        source,
        category: categorize(normalizeText(title)),
        publishedAt: Number.isNaN(dateObj.getTime()) ? "N/A" : dateObj.toISOString(),
      });
    }

    return entries;
  }, [categorize]);

  const parseItem = useCallback((item, source) => {
    const rawDate = item.pubDate || item.published;
    const dateObj = rawDate ? new Date(rawDate) : null;
    const publishedAt = (dateObj && !Number.isNaN(dateObj.getTime())) ? dateObj.toISOString() : "N/A";

    return {
      title: normalizeText(item.title || ""),
      description: normalizeText(item.description || "").substring(0, 180),
      url: item.link || item.url,
      image: item.enclosure?.link || item.thumbnail || FALLBACK_IMAGE,
      source: normalizeText(source),
      category: categorize(normalizeText(item.title || "")),
      publishedAt,
    };
  }, [categorize]);

  const parseXmlItem = useCallback((item, source) => {
    const desc = item.querySelector("description, summary, content")?.textContent || "";
    let img = item.querySelector("enclosure")?.getAttribute("url") || item.querySelector("content[url]")?.getAttribute("url") || "";
    if (!img) {
      const match = desc.match(/<img[^>]+src="([^">]+)"/);
      if (match) img = match[1];
    }

    const rawDate = item.querySelector("pubDate, published, updated")?.textContent;
    const dateObj = rawDate ? new Date(rawDate) : null;
    const publishedAt = (dateObj && !Number.isNaN(dateObj.getTime())) ? dateObj.toISOString() : "N/A";

    return {
      title: normalizeText(item.querySelector("title")?.textContent || ""),
      description: normalizeText(desc.replace(/<[^>]*>?/gm, '')).substring(0, 180),
      url: item.querySelector("link")?.textContent || item.querySelector("link")?.getAttribute("href") || "#",
      image: img || FALLBACK_IMAGE,
      source: normalizeText(source),
      category: categorize(normalizeText(item.querySelector("title")?.textContent || "")),
      publishedAt,
    };
  }, [categorize]);

  const fetchSourceFallbackItems = useCallback(async (source) => {
    if (source.name !== "Haberturk") return [];

    try {
      const fallbackUrl = `https://r.jina.ai/http://${source.url.replace(/^https?:\/\//, "")}`;
      const res = await fetch(fallbackUrl, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) return [];
      const markdown = await res.text();
      return parseMarkdownFeed(markdown, source.name);
    } catch {
      return [];
    }
  }, [parseMarkdownFeed]);

  const saveToFirestoreBatch = useCallback(async (items) => {
    const validItems = items.filter((item) => item.url && item.url !== "#" && item.publishedAt !== "N/A" && isValidPublishedAt(item.publishedAt));
    if (validItems.length === 0) return;

    const batch = writeBatch(db);
    validItems.forEach((item) => {
      const id = btoa(unescape(encodeURIComponent(item.url))).substring(0, 150).replace(/\//g, '_');
      batch.set(doc(db, "news", id), { ...item, updatedAt: serverTimestamp() }, { merge: true });
    });
    await batch.commit();
  }, []);

  const runSync = useCallback(async () => {
    if (syncInFlight.current) return false;

    syncInFlight.current = true;
    setSyncing(true);
    setSyncMessage("Kaynaklar guncelleniyor...");
    try {
      const allNewItems = [];
      const sourceHealth = [];

      for (const source of RSS_SOURCES) {
        const sourceItems = [];
        const sourceDiagnostics = [];

        for (const proxy of PROXIES) {
          try {
            const res = await fetch(proxy.fn(source.url), { signal: AbortSignal.timeout(8000) });
            if (!res.ok) {
              sourceDiagnostics.push({ proxy: proxy.name, status: "http_error", code: res.status });
              continue;
            }

            if (proxy.name === "RSS2JSON") {
              const data = await res.json();
              if (data.status === "ok" && Array.isArray(data.items)) {
                sourceItems.push(...data.items.map((item) => parseItem(item, source.name)));
                sourceDiagnostics.push({ proxy: proxy.name, status: "ok", items: data.items.length });
              } else {
                sourceDiagnostics.push({ proxy: proxy.name, status: "empty" });
              }
              continue;
            }

            const xml = proxy.name === "AllOrigins" ? (await res.json()).contents : await res.text();
            if (!xml || (!xml.includes("<item") && !xml.includes("<entry"))) {
              sourceDiagnostics.push({ proxy: proxy.name, status: "empty" });
              continue;
            }

            const parsed = new DOMParser().parseFromString(xml, "text/xml");
            const items = Array.from(parsed.querySelectorAll("item, entry")).slice(0, 50);
            sourceItems.push(...items.map((item) => parseXmlItem(item, source.name)));
            sourceDiagnostics.push({ proxy: proxy.name, status: "ok", items: items.length });
          } catch {
            sourceDiagnostics.push({ proxy: proxy.name, status: "error" });
            continue;
          }
        }

        const fallbackItems = await fetchSourceFallbackItems(source);
        if (fallbackItems.length > 0) {
          sourceItems.push(...fallbackItems);
          sourceDiagnostics.push({ proxy: "JinaFallback", status: "ok", items: fallbackItems.length });
        }

        const mergedItems = mergeSourceItems(sourceItems).slice(0, 30);
        allNewItems.push(...mergedItems);
        sourceHealth.push({
          source: source.name,
          url: source.url,
          itemCount: mergedItems.length,
          status: mergedItems.length > 0 ? "ok" : "empty",
          checkedAt: new Date().toISOString(),
          diagnostics: sourceDiagnostics,
        });
      }

      if (allNewItems.length > 0) {
        await saveToFirestoreBatch(allNewItems);
        await setDoc(doc(db, "settings", "lastSync"), { time: serverTimestamp() }, { merge: true });
        setSyncMessage(`Guncelleme tamamlandi. ${allNewItems.length} haber alindi.`);
      } else {
        setSyncMessage("Kaynaklardan veri alinamadi. Son durum gosteriliyor.");
      }

      await setDoc(doc(db, "settings", "feedHealth"), {
        updatedAt: serverTimestamp(),
        sources: sourceHealth,
      }, { merge: true });
      await refreshSyncStatus();
      return allNewItems.length > 0;
    } catch {
      await refreshSyncStatus();
      setSyncMessage("Guncelleme baslatilamadi. Son durum gosteriliyor.");
      return false;
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  }, [fetchSourceFallbackItems, parseItem, parseXmlItem, refreshSyncStatus, saveToFirestoreBatch]);

  const triggerManualSync = useCallback(async () => {
    await runSync();
  }, [runSync]);

  const syncStatusText = (() => {
    if (syncing) {
      return syncMessage || "Kaynaklar guncelleniyor...";
    }

    if (!lastSyncTs) {
      return "Canli akis";
    }

    if (Date.now() - lastSyncTs > STALE_SYNC_MS) {
      return `Guncelleme gecikti: ${formatDistanceToNow(lastSyncTs, { addSuffix: true, locale: tr })}`;
    }

    return `Guncellendi: ${formatDistanceToNow(lastSyncTs, { addSuffix: true, locale: tr })}`;
  })();

  const startApp = useCallback(async () => {
    setLoading(true);

    const q = query(collection(db, "news"), orderBy("publishedAt", "desc"), limit(FIRESTORE_QUERY_LIMIT));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map((newsDoc) => normalizeNewsItem({ id: newsDoc.id, ...newsDoc.data() }));
      setAllNews(balanceNewsBySource(data));
      setLoading(false);
    }, () => setLoading(false));

    const lastTime = await refreshSyncStatus();
    if (!lastTime || Date.now() - lastTime > AUTO_SYNC_INTERVAL_MS) {
      void runSync();
    }
    return unsubscribe;
  }, [refreshSyncStatus, runSync]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    const handleScroll = () => setShowScrollTop(window.scrollY > 400);

    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll);

    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      setDarkMode(true);
      document.documentElement.setAttribute('data-theme', 'dark');
    }

    if (isRunning.current) return undefined;
    isRunning.current = true;

    const unsubscribePromise = startApp();
    const intervalId = window.setInterval(async () => {
      const lastTime = await refreshSyncStatus();
      if (!lastTime || Date.now() - lastTime > AUTO_SYNC_INTERVAL_MS) {
        void runSync();
      }
    }, 60 * 1000);

    return () => {
      unsubscribePromise.then((unsubscribe) => unsubscribe?.());
      window.clearInterval(intervalId);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
    };
  }, [refreshSyncStatus, runSync, startApp]);

  const filteredNews = sortNewsByDate(
    activeCategory === "T\u00fcm\u00fc" ? allNews : allNews.filter((item) => item.category === activeCategory)
  );
  const sliderLimit = isMobile ? 8 : 20;
  const sliderHaberler = buildSliderNews(filteredNews, sliderLimit);
  const gridHaberler = filteredNews.slice(0, visibleCount);

  useEffect(() => {
    setCurrentSlide(0);
  }, [activeCategory, allNews, sliderLimit]);

  const onHandleStart = (e) => {
    isDragging.current = true;
    startX.current = e.pageX || e.touches[0].pageX;
  };

  const onHandleEnd = (e) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    const endX = e.pageX || e.changedTouches[0].pageX;
    const diff = startX.current - endX;
    if (Math.abs(diff) > 50) {
      if (diff > 0) setCurrentSlide((p) => (p === sliderHaberler.length - 1 ? 0 : p + 1));
      else setCurrentSlide((p) => (p === 0 ? sliderHaberler.length - 1 : p - 1));
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <button className="mobile-menu-btn" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}><Menu /></button>
          <div className="brand" onClick={() => window.location.reload()}><Flame className="brand-icon" size={28} /><span>Bilgin Haber</span></div>
        </div>
        <nav className={`header-center ${isMobileMenuOpen ? 'mobile-open' : ''}`}>
          {isMobileMenuOpen && <div className="mobile-nav-header"><Flame size={24} /><span>Kategoriler</span><button onClick={() => setIsMobileMenuOpen(false)}><X /></button></div>}
          {CATEGORIES.map((cat) => (
            <button key={cat} className={`nav-link ${activeCategory === cat ? 'active' : ''}`} onClick={() => { setActiveCategory(cat); setVisibleCount(40); window.scrollTo({ top: 0, behavior: 'smooth' }); setIsMobileMenuOpen(false); }}>{cat}</button>
          ))}
        </nav>
        <div className="header-right">
          <button className="icon-btn refresh-trigger" onClick={triggerManualSync} disabled={syncing} title="Simdi Guncelle"><RefreshCw size={20} className={syncing ? "spin" : ""} /></button>
          <button className="icon-btn" onClick={() => {
            const mode = !darkMode;
            setDarkMode(mode);
            document.documentElement.setAttribute('data-theme', mode ? 'dark' : 'light');
            localStorage.setItem('theme', mode ? 'dark' : 'light');
          }} title="Tema De\u011fi\u015ftir">{darkMode ? <Sun /> : <Moon />}</button>
        </div>
      </header>

      <main className="main-container">
        {loading ? (
          <div className="loading-container"><div className="spinner"></div><p style={{ marginTop: '1.5rem' }}>{'Haber Ak\u0131\u015f\u0131 Haz\u0131rlan\u0131yor...'}</p></div>
        ) : (
          <div className="fade-in">
            <div className="sync-info-row">
              <div className={`status-pill ${syncing ? 'syncing' : ''}`}>
                {syncing ? <RefreshCw size={14} className="spin" /> : <AlertCircle size={14} />}
                {syncStatusText}
              </div>
              <div className="sort-label">{'Zengin Haber Ak\u0131\u015f\u0131'}</div>
            </div>

            {sliderHaberler.length > 0 && (
              <section className="hero-grid-wrapper">
                <div className="slider-main" onMouseDown={onHandleStart} onMouseUp={onHandleEnd} onTouchStart={onHandleStart} onTouchEnd={onHandleEnd}>
                  <div className="slider-track" style={{ transform: `translateX(-${currentSlide * 100}%)` }}>
                    {sliderHaberler.map((item, index) => (
                      <div key={item.id || index} className="slide">
                        <a href={item.url} target="_blank" rel="noopener noreferrer" className="slide-link">
                          <img src={item.image} alt={item.title} className="slide-img" draggable="false" onError={(e) => { e.target.onerror = null; e.target.src = FALLBACK_IMAGE; }} />
                          <div className="slide-content">
                            <div className="slide-meta"><span className="source-tag">{item.source}</span>{" "}<span className="time-tag">{formatPublishedDistance(item.publishedAt)}</span></div>
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
                        <p className="aside-source">{item.source} {formatPublishedDistance(item.publishedAt)}</p>
                        <h3 className="aside-title">{item.title}</h3>
                      </div>
                    </div>
                  ))}
                </aside>
              </section>
            )}

            <section className="main-grid-section">
              <h2 className="grid-header">{'En Yeni Geli\u015fmeler'}</h2>
              <div className="news-grid">
                {gridHaberler.map((item, idx) => (
                  <article key={item.id || idx} className="news-card">
                    <div className="card-media">
                      <a href={item.url} target="_blank" rel="noopener noreferrer">
                        <img src={item.image} alt={item.title} className="card-img" onError={(e) => { e.target.onerror = null; e.target.src = FALLBACK_IMAGE; }} />
                      </a>
                      <span className="card-badge">{item.source}</span>
                    </div>
                    <div className="card-body">
                      <div className="card-top">
                        <span className="card-cat">{item.category}</span>
                        <span className="card-sep">&nbsp;</span>
                        <span className="card-time">{formatPublishedDistance(item.publishedAt)}</span>
                      </div>
                      <h2 className="card-title">{item.title}</h2>
                      <div className="card-footer">
                        <a href={item.url} target="_blank" rel="noopener noreferrer" className="btn-read">Habere Git <ExternalLink size={14} /></a>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
              {visibleCount < filteredNews.length && (
                <div className="load-more-center"><button className="btn-more" onClick={() => setVisibleCount((p) => p + 15)}>Daha Fazla Goster</button></div>
              )}
            </section>
          </div>
        )}
      </main>

      <button className={`scroll-to-top ${showScrollTop ? 'visible' : ''}`} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><ArrowUp size={24} /></button>
      <footer className="app-footer"><div className="footer-content"><Flame size={20} /> <span>{'Bilgin Haber \u00a9 2026 - T\u00fcm Haklar\u0131 Sakl\u0131d\u0131r'}</span></div></footer>

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

        .app-header { position: sticky; top: 0; z-index: 1000; height: 75px; display: flex; align-items: center; justify-content: space-between; padding: 0 5%; background: var(--header-bg); backdrop-filter: saturate(180%) blur(25px); border-bottom: 1px solid var(--border-color); }
        .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 1.5rem; color: var(--primary); cursor: pointer; }
        .header-center { display: flex; gap: 15px; }
        .nav-link { background: none; border: none; color: var(--text-secondary); font-weight: 700; cursor: pointer; transition: 0.3s; padding: 8px 12px; }
        .nav-link.active { color: var(--primary); }
        .mobile-menu-btn { display: none; background: none; border: none; color: var(--text-main); cursor: pointer; }

        .sync-info-row { display: flex; justify-content: space-between; align-items: center; margin: 1.5rem 0 2rem; }
        .status-pill, .sort-label { display: flex; align-items: center; gap: 10px; font-size: 0.85rem; font-weight: 900; background: var(--card-bg); padding: 10px 22px; border-radius: 40px; border: 1px solid var(--border-color); color: var(--text-secondary); box-shadow: var(--shadow-sm); }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 2s linear infinite; }

        .main-container { max-width: 1400px; margin: 0 auto; padding: 0 5% 5rem; }

        .hero-grid-wrapper { display: grid; grid-template-columns: 2.5fr 1fr; gap: 24px; height: 500px; margin-bottom: 4.5rem; position: relative; z-index: 20; }
        .slider-main { position: relative; border-radius: 28px; overflow: hidden; background: #000; box-shadow: var(--shadow-md); height: 100%; cursor: grab; }
        .slider-track { display: flex; height: 100%; transition: transform 0.6s cubic-bezier(0.16, 1, 0.3, 1); pointer-events: none; }
        .slide { flex: 0 0 100%; height: 100%; position: relative; pointer-events: auto; }
        .slide-img { width: 100%; height: 100%; object-fit: cover; opacity: 0.8; -webkit-user-drag: none; }
        .slide-content { position: absolute; bottom: 0; left: 0; width: 100%; padding: 96px 32px 72px; background: linear-gradient(transparent, rgba(0,0,0,0.95)); color: white; pointer-events: none; }
        .slide-title { font-size: clamp(1.2rem, 2.4vw, 2rem); font-weight: 900; line-height: 1.15; margin: 0; max-width: min(100%, 680px); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; text-wrap: balance; word-break: break-word; }

        .slider-numbers-container { position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%); z-index: 100; background: rgba(0,0,0,0.6); padding: 8px 15px; border-radius: 50px; backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.15); }
        .num-scroll-helper { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; }
        .slider-num-btn { background: rgba(255,255,255,0.25); color: white; border: none; min-width: 32px; height: 32px; border-radius: 50%; font-size: 0.9rem; font-weight: 900; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; transition: 0.2s; }
        .slider-num-btn.active { background: var(--primary); transform: scale(1.1); }

        .slider-aside { display: flex; flex-direction: column; gap: 12px; height: 100%; overflow-y: auto; scrollbar-width: none; }
        .aside-card { display: flex; gap: 15px; padding: 16px; border-radius: 20px; background: var(--card-bg); cursor: pointer; border: 1px solid var(--border-color); transition: 0.3s; }
        .aside-card.active { border-color: var(--primary); background: rgba(255, 59, 48, 0.05); }
        .aside-info { min-width: 0; }
        .aside-source { font-size: 0.75rem; line-height: 1.35; color: var(--text-secondary); margin: 0 0 6px; }
        .aside-title { font-size: 0.95rem; line-height: 1.35; margin: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; word-break: break-word; }

        .main-grid-section { position: relative; z-index: 10; padding-top: 1rem; clear: both; }
        .news-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 30px; }
        .news-card { background: var(--card-bg); border-radius: 28px; overflow: hidden; border: 1px solid var(--border-color); display: flex; flex-direction: column; transition: 0.3s; box-shadow: var(--shadow-sm); }
        .card-media { height: 220px; position: relative; overflow: hidden; }
        .card-badge { position: absolute; top: 15px; right: 15px; background: var(--primary); color: white; padding: 6px 12px; border-radius: 10px; font-size: 0.75rem; font-weight: 900; z-index: 10; }
        .card-body { padding: 25px; flex-grow: 1; display: flex; flex-direction: column; }
        .card-title { font-size: 1.25rem; font-weight: 800; line-height: 1.4; color: var(--text-main); margin-bottom: 25px; }

        .card-footer { margin-top: auto; padding-top: 15px; border-top: 1px solid var(--border-color); }
        .btn-read { display: flex; align-items: center; justify-content: center; gap: 8px; background: var(--primary); color: white; padding: 12px 20px; border-radius: 15px; font-weight: 800; text-decoration: none; transition: 0.3s; border: none; cursor: pointer; }
        .btn-read:hover { background: var(--primary-dark); transform: translateY(-2px); box-shadow: 0 5px 15px rgba(255, 59, 48, 0.3); }
        .load-more-center { display: flex; justify-content: center; margin-top: 2.75rem; }
        .btn-more { display: inline-flex; align-items: center; justify-content: center; min-width: 220px; padding: 14px 22px; border-radius: 999px; border: 1px solid rgba(255, 59, 48, 0.18); background: linear-gradient(135deg, rgba(255,255,255,0.98), rgba(255,244,243,0.96)); color: var(--text-main); font-size: 0.98rem; font-weight: 800; letter-spacing: 0.01em; box-shadow: 0 14px 30px rgba(17, 24, 39, 0.08), inset 0 1px 0 rgba(255,255,255,0.9); cursor: pointer; transition: transform 0.22s ease, box-shadow 0.22s ease, border-color 0.22s ease, background 0.22s ease; }
        .btn-more:hover { transform: translateY(-2px); border-color: rgba(255, 59, 48, 0.35); box-shadow: 0 18px 36px rgba(255, 59, 48, 0.14), inset 0 1px 0 rgba(255,255,255,0.95); background: linear-gradient(135deg, rgba(255,255,255,1), rgba(255,238,235,1)); }
        .btn-more:active { transform: translateY(0); box-shadow: 0 10px 20px rgba(255, 59, 48, 0.12); }

        .scroll-to-top { position: fixed; bottom: 40px; right: 40px; background: var(--primary); color: white; width: 60px; height: 60px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; opacity: 0; visibility: hidden; transition: 0.4s; z-index: 1500; cursor: pointer; box-shadow: 0 10px 30px rgba(255, 59, 48, 0.4); }
        .scroll-to-top.visible { opacity: 1; visibility: visible; }

        @media (max-width: 1024px) {
          .mobile-menu-btn { display: block; }
          .header-center { position: fixed; top: 0; left: -105%; width: 280px; height: 100vh; background: var(--card-bg); flex-direction: column; align-items: flex-start; padding: 25px; transition: 0.4s cubic-bezier(0.16, 1, 0.3, 1); z-index: 2000; box-shadow: 20px 0 50px rgba(0,0,0,0.2); }
          .header-center.mobile-open { left: 0; }
          .news-grid { grid-template-columns: repeat(2, 1fr); }
          .hero-grid-wrapper { grid-template-columns: 1fr; height: auto; margin-bottom: 2rem; }
          .slider-main { height: 380px; }
          .slide-content { padding: 72px 20px 64px; }
          .slide-title { font-size: clamp(1.05rem, 4.6vw, 1.5rem); -webkit-line-clamp: 3; max-width: 100%; }
          .slider-aside { display: none; }
        }
        @media (max-width: 600px) {
          .slider-main { height: 320px; }
          .slide-content { padding: 56px 16px 60px; }
        }
      `}</style>
    </div>
  );
}

export default App;
