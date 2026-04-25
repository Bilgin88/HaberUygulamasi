import { useState, useEffect, useRef, useCallback } from 'react';
import { Flame, Moon, Sun, Menu, X, ArrowUp, ExternalLink, RefreshCw, AlertCircle } from 'lucide-react';
import { db } from './firebase';
import { collection, query, orderBy, limit, onSnapshot, doc, getDoc, getDocs, setDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { formatDistanceToNow } from 'date-fns';
import { tr } from 'date-fns/locale';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';

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
const DETAIL_FALLBACK_MIN_CHARS = 260;
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
const COOKIE_CONSENT_VERSION = "2026-04-25";
const COOKIE_CONSENT_STORAGE_KEY = "bilgin-cookie-consent";
const COOKIE_CONSENT_ID_STORAGE_KEY = "bilgin-cookie-consent-id";
const THEME_STORAGE_KEY = "theme";

const createDefaultCookieConsent = () => ({
  version: COOKIE_CONSENT_VERSION,
  status: "pending",
  necessary: true,
  preferences: false,
  performance: false,
  updatedAt: null,
});

const readCookieConsent = () => {
  if (typeof window === "undefined") return createDefaultCookieConsent();

  try {
    const rawValue = window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY);
    if (!rawValue) return createDefaultCookieConsent();

    const parsed = JSON.parse(rawValue);
    if (!parsed || parsed.version !== COOKIE_CONSENT_VERSION) {
      return createDefaultCookieConsent();
    }

    return {
      ...createDefaultCookieConsent(),
      ...parsed,
      necessary: true,
    };
  } catch {
    return createDefaultCookieConsent();
  }
};

const writeCookieConsent = (consent) => {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, JSON.stringify(consent));
  } catch {
    // ignore storage access issues
  }
};

const getCookieConsentId = () => {
  if (typeof window === "undefined") return "server";

  try {
    const existing = window.localStorage.getItem(COOKIE_CONSENT_ID_STORAGE_KEY);
    if (existing) return existing;

    const nextId = window.crypto?.randomUUID?.() || `consent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(COOKIE_CONSENT_ID_STORAGE_KEY, nextId);
    return nextId;
  } catch {
    return `consent-${Date.now()}`;
  }
};

const canUseCookieCategory = (category) => {
  if (category === "necessary") return true;
  const consent = readCookieConsent();
  return Boolean(consent?.[category]);
};

const readThemePreference = () => {
  if (typeof window === "undefined" || !canUseCookieCategory("preferences")) return null;

  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeThemePreference = (themeValue) => {
  if (typeof window === "undefined" || !canUseCookieCategory("preferences")) return;

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeValue);
  } catch {
    // ignore storage access issues
  }
};

const clearOptionalCookieStorage = ({ clearPreferences = false, clearPerformance = false } = {}) => {
  if (typeof window === "undefined") return;

  if (clearPreferences) {
    try {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } catch {
      // ignore localStorage access issues
    }
  }

  if (clearPerformance) {
    try {
      const keysToRemove = [];
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index);
        if (key?.startsWith("article-fallback:")) {
          keysToRemove.push(key);
        }
      }

      keysToRemove.forEach((key) => window.sessionStorage.removeItem(key));
    } catch {
      // ignore sessionStorage access issues
    }
  }
};

const persistCookieConsentToDb = async (consent, route) => {
  try {
    const consentId = getCookieConsentId();
    await setDoc(doc(db, "cookieConsents", consentId), {
      consentId,
      source: "web",
      policyVersion: consent.version,
      status: consent.status,
      categories: {
        necessary: true,
        preferences: Boolean(consent.preferences),
        performance: Boolean(consent.performance),
      },
      route,
      updatedAt: serverTimestamp(),
      updatedAtClient: new Date().toISOString(),
    }, { merge: true });
  } catch {
    // consent banner should keep working even if audit write fails
  }
};

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
  if (normalized === "CNN TÃ¼rk") return "CNN Turk";
  if (normalized === "HabertÃ¼rk") return "Haberturk";
  if (normalized === "HÃ¼rriyet") return "Hurriyet";
  if (normalized === "SÃ¶zcÃ¼") return "Sozcu";
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

const buildGridNews = (items = [], limitCount = 40) => {
  const sortedItems = sortNewsByDate(items);
  const bySource = new Map();

  for (const item of sortedItems) {
    const source = normalizeSourceName(item.source || "Bilinmeyen");
    const bucket = bySource.get(source) || [];
    bucket.push({ ...item, source });
    bySource.set(source, bucket);
  }

  const sourceNames = Array.from(bySource.keys());
  const gridItems = [];
  const seenUrls = new Set();
  let round = 0;

  while (gridItems.length < limitCount) {
    let addedInRound = false;

    for (const source of sourceNames) {
      const bucket = bySource.get(source) || [];
      const item = bucket[round];
      if (!item || seenUrls.has(item.url)) continue;
      gridItems.push(item);
      seenUrls.add(item.url);
      addedInRound = true;

      if (gridItems.length >= limitCount) break;
    }

    if (!addedInRound) break;
    round += 1;
  }

  return sortNewsByDate(gridItems);
};

const slugifyTitle = (value = "") =>
  normalizeText(value)
    .toLocaleLowerCase('tr-TR')
    .replace(/['".,!?%:;()[\]{}]/g, "")
    .replace(/&/g, " ve ")
    .replace(/[^a-z0-9\u00c0-\u024f\s-]/gi, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "haber";

const buildNewsRoute = (newsId = "", title = "") => {
  const slug = slugifyTitle(title);
  return `/haber/${slug}--${encodeURIComponent(newsId)}`;
};

const extractNewsIdFromRouteParam = (routeParam = "") => {
  const decodedParam = routeParam ? decodeURIComponent(routeParam) : "";
  if (!decodedParam) return "";

  const separatorIndex = decodedParam.lastIndexOf("--");
  if (separatorIndex === -1) return decodedParam;

  return decodedParam.slice(separatorIndex + 2);
};

const buildDetailParagraphs = (description = "") => {
  const normalized = normalizeText(description);
  if (!normalized) return [];

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length === 0) return [normalized];

  const paragraphs = [];
  let current = "";

  for (const sentence of sentences) {
    const nextValue = current ? `${current} ${sentence}` : sentence;
    if (nextValue.length > 700 && current) {
      paragraphs.push(current);
      current = sentence;
      continue;
    }
    current = nextValue;
  }

  if (current) {
    paragraphs.push(current);
  }

  return paragraphs.filter(Boolean);
};

const stripMarkdownDecorations = (line = "") =>
  normalizeText(
    String(line)
      .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\*\s+/, "")
  );

const extractHaberlerArticleText = (markdown = "", title = "") => {
  const normalizedTitle = normalizeText(title).toLowerCase();
  const lines = String(markdown).split(/\r?\n/);
  const startIndex = lines.findIndex((line) => stripMarkdownDecorations(line).toLowerCase() === normalizedTitle);

  if (startIndex === -1) return "";

  const paragraphs = [];
  let contentStarted = false;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = stripMarkdownDecorations(rawLine);
    if (!line) continue;

    if (/^(Kaynak:|Yorumunuzu Yazin|BIZI TAKIP EDIN|UYGULAMAMIZI INDIRIN|© Copyright|Haberler\.com:)/i.test(line)) break;
    if (/^\d{2}\.\d{2}\.\d{4}/.test(line)) continue;
    if (/^(Güncelleme|Guncelleme):/i.test(line)) continue;
    if (/^(Facebook'da|Twitter'da|WhatsApp'da|Google News'de) Paylas/i.test(line)) continue;
    if (/^(Anasayfa|Spor|Son Dakika|Maç Sonuçlari|Puan Durumu|Futbol|Besiktas|Fenerbahçe|Galatasaray|Espor)$/i.test(line)) continue;
    if (/^\d+\.\s+/.test(line)) continue;
    if (/^Image \d+:/i.test(line)) continue;
    if (/^Ara$/i.test(line)) continue;
    if (/^ÜYE GIRISI$/i.test(line)) continue;
    if (line.length < 40 && !/^[A-ZÇĞİÖŞÜ0-9\s'".,:-]+$/i.test(line)) continue;

    if (!contentStarted && !/^(##|###)/.test(rawLine) && line.length < 80) {
      continue;
    }

    contentStarted = true;
    paragraphs.push(line);
  }

  return normalizeText(paragraphs.join("\n\n"));
};

const extractArticleTextFromMarkdown = (markdown = "", title = "", url = "") => {
  if (/haberler\.com/i.test(url)) {
    const sourceSpecific = extractHaberlerArticleText(markdown, title);
    if (sourceSpecific) return sourceSpecific;
  }

  const normalizedTitle = normalizeText(title);
  const lines = String(markdown)
    .split(/\r?\n/)
    .map((line) => stripMarkdownDecorations(line))
    .filter(Boolean);

  const paragraphs = [];
  let totalLength = 0;

  for (const line of lines) {
    if (!line) continue;
    if (normalizedTitle && line === normalizedTitle) continue;
    if (/^(Title:|URL Source:|Published Time:|Markdown Content:)/i.test(line)) continue;
    if (/^https?:\/\//i.test(line)) continue;
    if (line.startsWith("![") || line.startsWith("[")) continue;
    if (/^(Anasayfa|Son Dakika|Guncel|Güncel|Ekonomi|Magazin|Spor|Kripto|Dünya|Dunya|Sağlık|Saglik)$/i.test(line)) continue;
    if (line.length < 55 && !/[.!?]/.test(line)) continue;
    if (paragraphs.includes(line)) continue;

    paragraphs.push(line);
    totalLength += line.length;
    if (totalLength >= 8000) break;
  }

  return normalizeText(paragraphs.join("\n\n"));
};

const fetchArticleFallbackText = async (url, title = "") => {
  if (!url) return "";

  const cacheKey = `article-fallback:${url}`;
  if (canUseCookieCategory("performance")) {
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) return cached;
    } catch {
      // ignore sessionStorage access issues
    }
  }

  try {
    const fallbackUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, "")}`;
    const res = await fetch(fallbackUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return "";

    const markdown = await res.text();
    const extracted = extractArticleTextFromMarkdown(markdown, title, url);
    if (extracted && canUseCookieCategory("performance")) {
      try {
        sessionStorage.setItem(cacheKey, extracted);
      } catch {
        // ignore sessionStorage quota/access issues
      }
    }
    return extracted;
  } catch {
    return "";
  }
};

const DetailPageChromeStyles = () => (
  <style>{`
    :root {
      --primary: #ff3b30; --primary-dark: #d70015; --bg-main: #f8f9fa; --card-bg: #ffffff;
      --text-main: #1d1d1f; --text-secondary: #86868b; --border-color: #e5e5e7;
      --header-bg: rgba(255,255,255,0.8); --shadow-sm: 0 4px 20px rgba(0,0,0,0.06);
    }
    [data-theme='dark'] {
      --bg-main: #000000; --card-bg: #1c1c1e; --text-main: #f5f5f7; --text-secondary: #8e8e93;
      --border-color: #2c2c2e; --header-bg: rgba(0,0,0,0.8); --shadow-sm: 0 4px 20px rgba(255,255,255,0.04);
    }
    .app { min-height: 100vh; background: var(--bg-main); color: var(--text-main); }
    .app-header { position: sticky; top: 0; z-index: 1000; height: 75px; display: flex; align-items: center; justify-content: space-between; padding: 0 5%; background: var(--header-bg); backdrop-filter: saturate(180%) blur(25px); border-bottom: 1px solid var(--border-color); }
    .header-left { display: flex; align-items: center; gap: 16px; min-width: 0; }
    .header-center { display: flex; gap: 15px; }
    .header-right { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
    .nav-link { background: none; border: none; color: var(--text-secondary); font-weight: 700; cursor: pointer; transition: 0.3s; padding: 8px 12px; }
    .nav-link.active { color: var(--primary); }
    .mobile-menu-btn { display: none; background: none; border: none; color: var(--text-main); cursor: pointer; padding: 0; }
    .mobile-nav-header { display: none; }
    .icon-btn {
      width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center;
      border-radius: 999px; border: 1px solid var(--border-color); background: var(--card-bg); color: var(--text-main);
      cursor: pointer; transition: transform 0.2s ease, background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      box-shadow: var(--shadow-sm); padding: 0;
    }
    .icon-btn svg, .scroll-to-top svg { width: 20px; height: 20px; flex-shrink: 0; display: block; }
    .icon-btn:hover { transform: translateY(-1px); border-color: rgba(255, 59, 48, 0.24); box-shadow: 0 10px 24px rgba(17, 24, 39, 0.08); }
    .status-pill { display: inline-flex; align-items: center; gap: 10px; font-size: 0.85rem; font-weight: 900; background: var(--card-bg); padding: 10px 22px; border-radius: 40px; border: 1px solid var(--border-color); color: var(--text-secondary); box-shadow: var(--shadow-sm); }
    .main-container { max-width: 1400px; margin: 0 auto; padding: 0 5% 5rem; }
    .scroll-to-top { position: fixed; bottom: 40px; right: 40px; background: var(--primary); color: white; width: 60px; height: 60px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; opacity: 0; visibility: hidden; transition: 0.4s; z-index: 1500; cursor: pointer; box-shadow: 0 10px 30px rgba(255, 59, 48, 0.4); padding: 0; }
    .scroll-to-top.visible { opacity: 1; visibility: visible; }
    .app-footer { padding: 2rem 5%; border-top: 1px solid var(--border-color); color: var(--text-secondary); }
    .footer-content { display: flex; align-items: center; justify-content: center; gap: 10px; font-weight: 600; }
    @media (max-width: 1024px) {
      .mobile-menu-btn { display: block; }
      .header-center { position: fixed; top: 0; left: -105%; width: 280px; height: 100vh; background: var(--card-bg); flex-direction: column; align-items: flex-start; padding: 25px; transition: 0.4s cubic-bezier(0.16, 1, 0.3, 1); z-index: 2000; box-shadow: 20px 0 50px rgba(0,0,0,0.2); }
      .header-center.mobile-open { left: 0; }
      .mobile-nav-header { display: flex; align-items: center; justify-content: space-between; width: 100%; margin-bottom: 20px; }
      .mobile-nav-header button { background: none; border: none; color: var(--text-main); }
      .app-header { padding: 0 16px; }
      .main-container { padding: 0 16px 4rem; }
    }
  `}</style>
);

function NewsListPage() {
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
        description: normalizeText(body),
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
      description: normalizeText(item.description || ""),
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
      description: normalizeText(desc.replace(/<[^>]*>?/gm, '')),
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
    try {
      const initialSnapshot = await getDocs(q);
      const initialData = initialSnapshot.docs.map((newsDoc) => normalizeNewsItem({ id: newsDoc.id, ...newsDoc.data() }));
      setAllNews(balanceNewsBySource(initialData));
    } catch {
      // Keep snapshot listener below as a fallback even if the first read fails.
    } finally {
      setLoading(false);
    }

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

    const savedTheme = readThemePreference();
    if (savedTheme === 'dark') {
      setDarkMode(true);
      document.documentElement.setAttribute('data-theme', 'dark');
    }

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
  const gridHaberler = buildGridNews(filteredNews, visibleCount);

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
            writeThemePreference(mode ? 'dark' : 'light');
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
                        <Link to={buildNewsRoute(item.id, item.title)} className="slide-link">
                          <img src={item.image} alt={item.title} className="slide-img" draggable="false" onError={(e) => { e.target.onerror = null; e.target.src = FALLBACK_IMAGE; }} />
                          <div className="slide-content">
                            <div className="slide-meta"><span className="source-tag">{item.source}</span>{" "}<span className="time-tag">{formatPublishedDistance(item.publishedAt)}</span></div>
                            <h2 className="slide-title">{item.title}</h2>
                          </div>
                        </Link>
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
                      <Link to={buildNewsRoute(item.id, item.title)}>
                        <img src={item.image} alt={item.title} className="card-img" onError={(e) => { e.target.onerror = null; e.target.src = FALLBACK_IMAGE; }} />
                      </Link>
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
                        <Link to={buildNewsRoute(item.id, item.title)} className="btn-read">Haberi Ac <ExternalLink size={14} /></Link>
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
        .header-right { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
        .icon-btn {
          width: 44px;
          height: 44px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1px solid var(--border-color);
          background: var(--card-bg);
          color: var(--text-main);
          cursor: pointer;
          transition: transform 0.2s ease, background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
          box-shadow: var(--shadow-sm);
          padding: 0;
        }
        .icon-btn svg,
        .scroll-to-top svg {
          width: 20px;
          height: 20px;
          flex-shrink: 0;
          display: block;
        }
        .icon-btn:hover {
          transform: translateY(-1px);
          border-color: rgba(255, 59, 48, 0.24);
          box-shadow: 0 10px 24px rgba(17, 24, 39, 0.08);
        }
        .icon-btn:disabled {
          opacity: 0.6;
          cursor: default;
          transform: none;
          box-shadow: var(--shadow-sm);
        }

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
        [data-theme='dark'] .btn-more { color: #f5f5f7; border-color: rgba(255,255,255,0.14); background: linear-gradient(135deg, rgba(46,46,50,0.98), rgba(28,28,30,0.96)); box-shadow: 0 14px 30px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05); }
        [data-theme='dark'] .btn-more:hover { border-color: rgba(255, 99, 88, 0.4); background: linear-gradient(135deg, rgba(56,56,60,1), rgba(34,34,36,1)); box-shadow: 0 18px 36px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.06); }

        .scroll-to-top { position: fixed; bottom: 40px; right: 40px; background: var(--primary); color: white; width: 60px; height: 60px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; opacity: 0; visibility: hidden; transition: 0.4s; z-index: 1500; cursor: pointer; box-shadow: 0 10px 30px rgba(255, 59, 48, 0.4); padding: 0; }
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

function NewsDetailPage() {
  const { newsId } = useParams();
  const navigate = useNavigate();
  const [newsItem, setNewsItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [darkMode, setDarkMode] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [detailBody, setDetailBody] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const detailParagraphs = buildDetailParagraphs(detailBody || newsItem?.description);
  const resolvedNewsId = extractNewsIdFromRouteParam(newsId);

  useEffect(() => {
    const savedTheme = readThemePreference();
    if (savedTheme === 'dark') {
      setDarkMode(true);
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
    }

    const handleScroll = () => setShowScrollTop(window.scrollY > 400);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const loadNewsItem = async () => {
      const decodedNewsId = resolvedNewsId;

      if (!decodedNewsId) {
        setLoading(false);
        return;
      }

      try {
        const newsDoc = await getDoc(doc(db, 'news', decodedNewsId));
        if (newsDoc.exists()) {
          setNewsItem(normalizeNewsItem({ id: newsDoc.id, ...newsDoc.data() }));
        } else {
          setNewsItem(null);
        }
      } catch {
        setNewsItem(null);
      } finally {
        setLoading(false);
      }
    };

    void loadNewsItem();
  }, [resolvedNewsId]);

  useEffect(() => {
    if (!newsItem) {
      setDetailBody("");
      setDetailLoading(false);
      return;
    }

    const baseDescription = normalizeText(newsItem.description || "");
    setDetailBody(baseDescription);

    if (baseDescription.length >= DETAIL_FALLBACK_MIN_CHARS || !newsItem.url) {
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);

    void fetchArticleFallbackText(newsItem.url, newsItem.title)
      .then((fallbackText) => {
        if (cancelled) return;
        if (fallbackText && fallbackText.length > baseDescription.length) {
          setDetailBody(fallbackText);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [newsItem]);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', background: darkMode ? "#000" : "#f8f9fa", color: darkMode ? "#f5f5f7" : "#1d1d1f" }}>
        Haber hazirlaniyor...
      </div>
    );
  }

  if (!newsItem) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', padding: "2rem", background: darkMode ? "#000" : "#f8f9fa", color: darkMode ? "#f5f5f7" : "#1d1d1f" }}>
        <div style={{ maxWidth: 680, textAlign: "center" }}>
          <h1 style={{ marginBottom: "1rem" }}>Haber bulunamadi</h1>
          <button onClick={() => navigate("/")} style={{ border: "none", background: "#ff3b30", color: "#fff", padding: "12px 20px", borderRadius: 12, cursor: "pointer", fontWeight: 700 }}>
            Listeye don
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <DetailPageChromeStyles />
      <header className="app-header">
        <div className="header-left">
          <button className="mobile-menu-btn" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}><Menu /></button>
          <button onClick={() => navigate("/")} style={{ display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", color: "#ff3b30", cursor: "pointer", fontWeight: 800, fontSize: "1.5rem" }}><Flame size={28} /><span>Bilgin Haber</span></button>
        </div>
        <nav className={`header-center ${isMobileMenuOpen ? 'mobile-open' : ''}`}>
          {isMobileMenuOpen && <div className="mobile-nav-header"><Flame size={24} /><span>Kategoriler</span><button onClick={() => setIsMobileMenuOpen(false)}><X /></button></div>}
          {CATEGORIES.map((cat) => (
            <button key={cat} className={`nav-link ${cat === "Tümü" ? 'active' : ''}`} onClick={() => navigate("/")}>{cat}</button>
          ))}
        </nav>
        <div className="header-right">
          <button className="icon-btn" onClick={() => navigate("/")} title="Listeye Don"><ArrowUp style={{ transform: "rotate(-90deg)" }} size={20} /></button>
          <button className="icon-btn" onClick={() => {
            const mode = !darkMode;
            setDarkMode(mode);
            document.documentElement.setAttribute('data-theme', mode ? 'dark' : 'light');
            writeThemePreference(mode ? 'dark' : 'light');
          }} title="Tema Değiştir">{darkMode ? <Sun /> : <Moon />}</button>
        </div>
      </header>
      <main className="main-container">
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2.2fr) minmax(280px, 0.9fr)", gap: 28, paddingTop: "1.75rem" }}>
          <article style={{ minWidth: 0 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 18 }}>
              <span className="status-pill">{newsItem.source}</span>
              <span className="status-pill">{newsItem.category}</span>
              <span className="status-pill">{formatPublishedDistance(newsItem.publishedAt)}</span>
            </div>
            <h1 style={{ fontSize: "clamp(2rem, 4vw, 3.6rem)", lineHeight: 1.06, margin: "0 0 18px", maxWidth: 900 }}>{newsItem.title}</h1>
            <p style={{ fontSize: "1.1rem", lineHeight: 1.75, color: darkMode ? "#d0d0d4" : "#3a3a3c", margin: "0 0 24px", maxWidth: 860 }}>
              {detailParagraphs[0] || "Bu haber icin uygulama icinde okunabilir ozet bulunamadi. Ayrintilar icin orijinal kaynaga gec."}
            </p>
            <img src={newsItem.image || FALLBACK_IMAGE} alt={newsItem.title} style={{ width: "100%", height: "min(52vw, 520px)", objectFit: "cover", borderRadius: 24, marginBottom: 24, border: `1px solid ${darkMode ? "#2f2f34" : "#e5e5e5"}` }} onError={(e) => { e.target.onerror = null; e.target.src = FALLBACK_IMAGE; }} />
            <div style={{ background: darkMode ? "#121214" : "#fff", border: `1px solid ${darkMode ? "#2f2f34" : "#e5e5e5"}`, borderRadius: 24, padding: "24px 24px 28px", boxShadow: darkMode ? "0 14px 30px rgba(0,0,0,0.25)" : "0 12px 30px rgba(17,24,39,0.08)" }}>
              <h2 style={{ margin: "0 0 14px", fontSize: "1.1rem" }}>Genel Detay</h2>
              <div style={{ display: "grid", gap: 16 }}>
                {detailParagraphs.length > 0 ? detailParagraphs.map((paragraph, index) => (
                  <p key={`${newsItem.id || newsItem.url}-${index}`} style={{ margin: 0, lineHeight: 1.9, color: darkMode ? "#d0d0d4" : "#3a3a3c", fontSize: "1.02rem" }}>
                    {paragraph}
                  </p>
                )) : (
                  <p style={{ margin: 0, lineHeight: 1.85, color: darkMode ? "#d0d0d4" : "#3a3a3c" }}>
                    Bu haber icin ozet bilgisi yok.
                  </p>
                )}
                {detailLoading && (
                  <p style={{ margin: 0, lineHeight: 1.8, color: darkMode ? "#8e8e93" : "#6e6e73", fontSize: "0.95rem" }}>
                    Kaynaktan daha fazla icerik aliniyor...
                  </p>
                )}
                <p style={{ margin: 0, lineHeight: 1.85, color: darkMode ? "#8e8e93" : "#6e6e73", fontSize: "0.98rem" }}>
                  Burada haberin ana akisini okuyabilirsin. Tam metin, ek detaylar ve kaynak icindeki baglamsal bilgi icin alttaki baglanti ile orijinal habere gecebilirsin.
                </p>
              </div>
            </div>
          </article>
          <aside style={{ alignSelf: "start", position: "sticky", top: 96 }}>
            <div style={{ background: darkMode ? "#121214" : "#fff", border: `1px solid ${darkMode ? "#2f2f34" : "#e5e5e5"}`, borderRadius: 24, padding: 22, boxShadow: darkMode ? "0 14px 30px rgba(0,0,0,0.25)" : "0 12px 30px rgba(17,24,39,0.08)" }}>
              <div style={{ display: "grid", gap: 12 }}>
                <button onClick={() => navigate("/")} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, background: darkMode ? "#1c1c1e" : "#fff", color: darkMode ? "#f5f5f7" : "#1d1d1f", padding: "12px 18px", borderRadius: 14, fontWeight: 800, border: `1px solid ${darkMode ? "#38383a" : "#e5e5e5"}`, cursor: "pointer" }}>
                  Listeye Don
                </button>
                <a href={newsItem.url} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, background: "#ff3b30", color: "#fff", padding: "12px 18px", borderRadius: 14, fontWeight: 800, textDecoration: "none" }}>
                  Kaynaga Git <ExternalLink size={16} />
                </a>
              </div>
              <div style={{ marginTop: 18, paddingTop: 18, borderTop: `1px solid ${darkMode ? "#2f2f34" : "#e5e5e5"}` }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 900, color: darkMode ? "#8e8e93" : "#86868b", marginBottom: 10 }}>Paylasim Linki</div>
                <div style={{ fontSize: "0.86rem", lineHeight: 1.6, color: darkMode ? "#d0d0d4" : "#3a3a3c", wordBreak: "break-all" }}>{window.location.href}</div>
              </div>
            </div>
          </aside>
        </div>
      </main>
      <button className={`scroll-to-top ${showScrollTop ? 'visible' : ''}`} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><ArrowUp size={24} /></button>
      <footer className="app-footer"><div className="footer-content"><Flame size={20} /> <span>{'Bilgin Haber \u00a9 2026 - T\u00fcm Haklar\u0131 Sakl\u0131d\u0131r'}</span></div></footer>
    </div>
  );
}

const CookieConsentBanner = ({ onAcceptAll, onRejectAll, onOpenSettings, onOpenNotice }) => (
  <div style={{ position: "fixed", left: 24, right: 24, bottom: 24, zIndex: 4000, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
    <div style={{ width: "min(980px, 100%)", background: "var(--card-bg)", color: "var(--text-main)", border: "1px solid var(--border-color)", borderRadius: 20, boxShadow: "0 24px 60px rgba(0,0,0,0.18)", padding: 20, pointerEvents: "auto" }}>
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ display: "grid", gap: 8 }}>
          <strong style={{ fontSize: "1rem" }}>Cerez Tercihleri</strong>
          <p style={{ margin: 0, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            Sitemizin calismasi icin zorunlu cerezleri kullanıyoruz. Tercih ve performans cerezleri ise ancak onay vermeniz halinde aktif olur.
          </p>
          <button onClick={onOpenNotice} style={{ padding: 0, border: "none", background: "none", color: "#ff3b30", fontWeight: 700, textAlign: "left", cursor: "pointer" }}>
            Cerez Aydinlatma Metni
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
          <button onClick={onAcceptAll} style={{ minHeight: 46, borderRadius: 14, border: "1px solid #ff3b30", background: "#ff3b30", color: "#fff", fontWeight: 800, cursor: "pointer" }}>Hepsini Kabul Et</button>
          <button onClick={onRejectAll} style={{ minHeight: 46, borderRadius: 14, border: "1px solid var(--border-color)", background: "var(--card-bg)", color: "var(--text-main)", fontWeight: 800, cursor: "pointer" }}>Hepsini Reddet</button>
          <button onClick={onOpenSettings} style={{ minHeight: 46, borderRadius: 14, border: "1px solid var(--border-color)", background: "var(--card-bg)", color: "var(--text-main)", fontWeight: 800, cursor: "pointer" }}>Tercihleri Yonet</button>
        </div>
      </div>
    </div>
  </div>
);

const CookieConsentModal = ({ draftConsent, onChange, onClose, onSave, onRejectAll, noticeOnly = false }) => (
  <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 4100, display: "grid", placeItems: "center", padding: 20 }}>
    <div style={{ width: "min(860px, 100%)", maxHeight: "85vh", overflowY: "auto", background: "var(--card-bg)", color: "var(--text-main)", borderRadius: 22, border: "1px solid var(--border-color)", boxShadow: "0 24px 60px rgba(0,0,0,0.22)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "20px 22px", borderBottom: "1px solid var(--border-color)" }}>
        <div>
          <strong style={{ display: "block", fontSize: "1.05rem" }}>Cerez Aydinlatma Metni</strong>
          <span style={{ color: "var(--text-secondary)", fontSize: "0.92rem" }}>KVKK kapsaminda aydinlatma ve acik riza tercihi</span>
        </div>
        <button onClick={onClose} style={{ width: 40, height: 40, borderRadius: 999, border: "1px solid var(--border-color)", background: "var(--card-bg)", color: "var(--text-main)", cursor: "pointer" }}>
          <X size={18} />
        </button>
      </div>
      <div style={{ padding: 22, display: "grid", gap: 22 }}>
        <section style={{ display: "grid", gap: 10 }}>
          <strong>Veri sorumlusu ve kapsam</strong>
          <p style={{ margin: 0, lineHeight: 1.7, color: "var(--text-secondary)" }}>
            Bu panel, Bilgin Haber uygulamasinda kullanilan cerez ve benzeri tarayici depolama teknolojileri icin hazirlanmistir. Acik riza gerektiren kategoriler varsayilan olarak kapali gelir.
          </p>
        </section>
        <section style={{ display: "grid", gap: 10 }}>
          <strong>Kullandigimiz kategoriler</strong>
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ padding: 16, borderRadius: 16, border: "1px solid var(--border-color)", background: "rgba(255,59,48,0.04)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 800 }}>Zorunlu Cerezler</div>
                  <div style={{ color: "var(--text-secondary)", lineHeight: 1.6, marginTop: 4 }}>Cerez tercihlerinizi hatirlamak ve izin panelinin calismasini saglamak icin kullanilir. Her zaman aktiftir.</div>
                </div>
                <span style={{ fontWeight: 800, color: "#ff3b30" }}>Her zaman acik</span>
              </div>
            </div>
            <label style={{ padding: 16, borderRadius: 16, border: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", cursor: noticeOnly ? "default" : "pointer" }}>
              <div>
                <div style={{ fontWeight: 800 }}>Tercih Cerezleri</div>
                <div style={{ color: "var(--text-secondary)", lineHeight: 1.6, marginTop: 4 }}>Tema seciminizin tekrar geldiginizde hatirlanmasini saglar. Hukuki dayanak acik rizanizdir.</div>
              </div>
              <input type="checkbox" checked={draftConsent.preferences} disabled={noticeOnly} onChange={(event) => onChange("preferences", event.target.checked)} />
            </label>
            <label style={{ padding: 16, borderRadius: 16, border: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", cursor: noticeOnly ? "default" : "pointer" }}>
              <div>
                <div style={{ fontWeight: 800 }}>Performans Cerezleri</div>
                <div style={{ color: "var(--text-secondary)", lineHeight: 1.6, marginTop: 4 }}>Detay sayfasinda ayni haber icin alinan ek icerigin gecici olarak saklanmasini saglar. Hukuki dayanak acik rizanizdir.</div>
              </div>
              <input type="checkbox" checked={draftConsent.performance} disabled={noticeOnly} onChange={(event) => onChange("performance", event.target.checked)} />
            </label>
          </div>
        </section>
        <section style={{ display: "grid", gap: 10 }}>
          <strong>Saklama ve haklariniz</strong>
          <p style={{ margin: 0, lineHeight: 1.7, color: "var(--text-secondary)" }}>
            Zorunlu tercih kaydi tarayicinizda tutulur. Acik riza karariniz ayrica ispat ve denetim amaciyla Firestore uzerinde anonim bir izin kaydi olarak saklanir. Tercihlerinizi istediginiz an yeniden degistirebilirsiniz.
          </p>
        </section>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 12, padding: "18px 22px", borderTop: "1px solid var(--border-color)" }}>
        <button onClick={onRejectAll} style={{ minHeight: 44, padding: "0 18px", borderRadius: 14, border: "1px solid var(--border-color)", background: "var(--card-bg)", color: "var(--text-main)", fontWeight: 800, cursor: "pointer" }}>
          Hepsini Reddet
        </button>
        {!noticeOnly && (
          <button onClick={onSave} style={{ minHeight: 44, padding: "0 18px", borderRadius: 14, border: "1px solid #ff3b30", background: "#ff3b30", color: "#fff", fontWeight: 800, cursor: "pointer" }}>
            Tercihleri Kaydet
          </button>
        )}
      </div>
    </div>
  </div>
);

const CookiePreferencesLink = ({ onOpen }) => (
  <button
    onClick={onOpen}
    style={{
      position: "fixed",
      left: 16,
      bottom: 16,
      zIndex: 3900,
      border: "1px solid var(--border-color)",
      background: "var(--card-bg)",
      color: "var(--text-main)",
      borderRadius: 999,
      padding: "10px 14px",
      fontWeight: 700,
      cursor: "pointer",
      boxShadow: "0 12px 28px rgba(0,0,0,0.12)",
    }}
  >
    Cerez Tercihleri
  </button>
);

function App() {
  const location = useLocation();
  const [cookieConsent, setCookieConsent] = useState(() => readCookieConsent());
  const [draftConsent, setDraftConsent] = useState(() => readCookieConsent());
  const [showCookieBanner, setShowCookieBanner] = useState(() => readCookieConsent().status === "pending");
  const [showCookieModal, setShowCookieModal] = useState(false);
  const [showCookieNotice, setShowCookieNotice] = useState(false);

  const applyCookieConsent = useCallback(async (nextConsent) => {
    const finalConsent = {
      ...createDefaultCookieConsent(),
      ...nextConsent,
      necessary: true,
      version: COOKIE_CONSENT_VERSION,
      updatedAt: new Date().toISOString(),
    };

    writeCookieConsent(finalConsent);
    clearOptionalCookieStorage({
      clearPreferences: !finalConsent.preferences,
      clearPerformance: !finalConsent.performance,
    });

    setCookieConsent(finalConsent);
    setDraftConsent(finalConsent);
    setShowCookieBanner(false);
    setShowCookieModal(false);
    setShowCookieNotice(false);

    await persistCookieConsentToDb(finalConsent, `${location.pathname}${location.hash}`);
  }, [location.hash, location.pathname]);

  const acceptAllCookies = useCallback(() => {
    void applyCookieConsent({
      status: "accepted",
      preferences: true,
      performance: true,
    });
  }, [applyCookieConsent]);

  const rejectAllCookies = useCallback(() => {
    void applyCookieConsent({
      status: "rejected",
      preferences: false,
      performance: false,
    });
  }, [applyCookieConsent]);

  const saveCustomCookieConsent = useCallback(() => {
    void applyCookieConsent({
      status: "customized",
      preferences: Boolean(draftConsent.preferences),
      performance: Boolean(draftConsent.performance),
    });
  }, [applyCookieConsent, draftConsent.performance, draftConsent.preferences]);

  return (
    <>
      <Routes>
        <Route path="/" element={<NewsListPage />} />
        <Route path="/haber/:newsId" element={<NewsDetailPage />} />
      </Routes>

      {showCookieBanner && (
        <CookieConsentBanner
          onAcceptAll={acceptAllCookies}
          onRejectAll={rejectAllCookies}
          onOpenSettings={() => {
            setDraftConsent(cookieConsent);
            setShowCookieModal(true);
          }}
          onOpenNotice={() => setShowCookieNotice(true)}
        />
      )}

      {!showCookieBanner && (
        <CookiePreferencesLink
          onOpen={() => {
            setDraftConsent(cookieConsent);
            setShowCookieModal(true);
          }}
        />
      )}

      {showCookieModal && (
        <CookieConsentModal
          draftConsent={draftConsent}
          onChange={(key, value) => setDraftConsent((current) => ({ ...current, [key]: value }))}
          onClose={() => setShowCookieModal(false)}
          onSave={saveCustomCookieConsent}
          onRejectAll={rejectAllCookies}
        />
      )}

      {showCookieNotice && (
        <CookieConsentModal
          draftConsent={cookieConsent}
          onChange={() => {}}
          onClose={() => setShowCookieNotice(false)}
          onSave={() => {}}
          onRejectAll={rejectAllCookies}
          noticeOnly
        />
      )}
    </>
  );
}

export default App;
