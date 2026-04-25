const admin = require("firebase-admin");
const Parser = require("rss-parser");
const axios = require("axios");
const RSS_SOURCES = require("../config/rssSources.json");

const parser = new Parser({
  customFields: {
    item: ["description", "image", "enclosure", "content:encoded"],
  },
});

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  Accept:
    "application/rss+xml, application/xml, text/xml, application/atom+xml, text/html;q=0.9, */*;q=0.8",
  "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6",
  "Cache-Control": "no-cache",
};

const FALLBACK_IMAGE =
  "https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=800&q=80";
const SOURCE_TIMEOUT_MS = 5000;
const MAX_ITEMS_PER_SOURCE = 15;
const CONCURRENCY = 3;

function cleanText(value = "") {
  return String(value)
    .replace(/<[^>]*>?/gm, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function categorizeNews(title, description) {
  const lookText = `${title} ${description}`.toLowerCase();

  if (lookText.match(/ekonomi|dolar|euro|altin|borsa|faiz|fiyat|zam|maas/)) {
    return "Ekonomi";
  }

  if (lookText.match(/spor|mac|futbol|basketbol|gol|lig|derbi|transfer/)) {
    return "Spor";
  }

  if (lookText.match(/teknoloji|iphone|yazilim|ai|yapay zeka|robot/)) {
    return "Teknoloji";
  }

  if (lookText.match(/dunya|abd|avrupa|rusya|ukrayna|israil/)) {
    return "Dunya";
  }

  if (lookText.match(/saglik|doktor|hastane|ilac|grip|kanser/)) {
    return "Saglik";
  }

  return "Gundem";
}

function pickImage(item, rawContent) {
  let image =
    item.enclosure?.url ||
    item.enclosure?.link ||
    item.image?.url ||
    item.thumbnail ||
    "";

  if (!image && rawContent) {
    const match = rawContent.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) {
      image = match[1];
    }
  }

  return image || FALLBACK_IMAGE;
}

function normalizePublishedAt(item) {
  const rawValue = item.isoDate || item.pubDate || item.published || item.updated;
  const parsed = rawValue ? new Date(rawValue) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toISOString()
    : new Date().toISOString();
}

function classifyFetchError(error) {
  const code = error?.code || "";
  const status = error?.response?.status;
  const message = String(error?.message || "").toLowerCase();

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "dns_error";
  }

  if (code === "ECONNABORTED" || message.includes("timeout")) {
    return "timeout";
  }

  if (status) {
    return `http_${status}`;
  }

  return "request_error";
}

function toDocId(url) {
  return Buffer.from(url).toString("base64").substring(0, 150);
}

async function parseFeed(source) {
  try {
    const response = await axios.get(source.url, {
      timeout: SOURCE_TIMEOUT_MS,
      responseType: "text",
      headers: REQUEST_HEADERS,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const xml = String(response.data || "").trim().replace(/^\uFEFF/, "");
    if (!xml || !xml.includes("<")) {
      const error = new Error("Bos veya gecersiz feed icerigi");
      error.health = "empty_response";
      throw error;
    }

    if (/^\s*<!doctype html/i.test(xml) || /^\s*<html/i.test(xml)) {
      const error = new Error("RSS yerine HTML dondu");
      error.health = "html_instead_of_xml";
      throw error;
    }

    const feed = await parser.parseString(xml);
    return { feed, health: "ok" };
  } catch (error) {
    if (error.health) {
      throw error;
    }

    const parserError = new Error(error.message);
    parserError.health = classifyFetchError(error);
    throw parserError;
  }
}

async function syncSource(db, source) {
  const batch = db.batch();
  const newsCollection = db.collection("news");
  const startedAt = Date.now();

  try {
    const { feed, health } = await parseFeed(source);
    const items = Array.isArray(feed?.items) ? feed.items.slice(0, MAX_ITEMS_PER_SOURCE) : [];
    let savedCount = 0;

    for (const item of items) {
      if (!item?.link) {
        continue;
      }

      const title = cleanText(item.title || "Haber");
      const rawContent =
        item["content:encoded"] || item.content || item.summary || item.description || "";
      let description = cleanText(rawContent);

      if (description.length < 20) {
        description = `${title}. Detaylar icin tiklayiniz.`;
      }

      batch.set(
        newsCollection.doc(toDocId(item.link)),
        {
          title: title.substring(0, 200),
          description: description.substring(0, 300),
          url: item.link,
          image: pickImage(item, rawContent),
          source: source.name,
          category: categorizeNews(title, description),
          publishedAt: normalizePublishedAt(item),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      savedCount += 1;
    }

    if (savedCount > 0) {
      await batch.commit();
    }

    return {
      source: source.name,
      url: source.url,
      tier: source.tier,
      enabled: source.enabled,
      health,
      savedCount,
      elapsedMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      source: source.name,
      url: source.url,
      tier: source.tier,
      enabled: source.enabled,
      health: error.health || "parse_error",
      savedCount: 0,
      elapsedMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
      error: error.message,
    };
  }
}

async function runWithConcurrency(items, worker, concurrency) {
  const results = [];
  let index = 0;

  async function consume() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => consume()
  );

  await Promise.all(runners);
  return results;
}

async function persistHealth(db, results) {
  const sources = {};

  for (const result of results) {
    sources[result.source] = result;
  }

  await db.collection("settings").doc("feedHealth").set(
    {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      sources,
    },
    { merge: true }
  );
}

async function persistLastSync(db, totalSaved) {
  await db.collection("settings").doc("lastSync").set(
    {
      time: admin.firestore.FieldValue.serverTimestamp(),
      totalSaved,
    },
    { merge: true }
  );
}

async function syncNews(db, options = {}) {
  const enabledSources = RSS_SOURCES.filter((source) => source.enabled);
  const results = await runWithConcurrency(
    enabledSources,
    (source) => syncSource(db, source),
    options.concurrency || CONCURRENCY
  );

  const totalSaved = results.reduce((sum, result) => sum + (result.savedCount || 0), 0);

  await Promise.all([persistHealth(db, results), persistLastSync(db, totalSaved)]);

  return {
    totalSaved,
    results,
  };
}

module.exports = {
  RSS_SOURCES,
  syncNews,
};
