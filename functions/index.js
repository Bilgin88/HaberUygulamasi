const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Parser = require("rss-parser");

admin.initializeApp();
const db = admin.firestore();
const parser = new Parser({
  customFields: {
    item: ['description', 'image', 'enclosure', 'content:encoded'],
  }
});

const RSS_SOURCES = [
  { name: "Sabah", url: "https://www.sabah.com.tr/rss/anasayfa.xml" },
  { name: "Habertürk", url: "https://www.haberturk.com/rss" },
  { name: "Haberler.com", url: "https://rss.haberler.com/rss.asp" },
  { name: "CNN Türk", url: "https://www.cnnturk.com/feed/rss/all/news" },
  { name: "Cumhuriyet", url: "https://www.cumhuriyet.com.tr/rss/1.xml" },
  { name: "Sözcü", url: "https://www.sozcu.com.tr/rss" },
  { name: "Haber7", url: "https://rss.haber7.com/rss.xml" },
  { name: "Star", url: "https://www.star.com.tr/rss/rss.asp" }
];

// --- CRON JOB: 5 DAKİKADA BİR ---
exports.fetchNewsCron = functions.pubsub.schedule("every 5 minutes").onRun(async (context) => {
  await fetchAndSaveNews();
});

// Manuel tetikleme için HTTP
exports.fetchNewsHttp = functions.https.onRequest(async (req, res) => {
  try {
    const count = await fetchAndSaveNews();
    res.status(200).send(`Sistem başarıyla çalıştı. ${count} yeni haber eklendi/güncellendi.`);
  } catch (error) {
    res.status(500).send("Hata: " + error.message);
  }
});

async function fetchAndSaveNews() {
  const newsCollection = db.collection("news");
  let totalSaved = 0;

  for (const source of RSS_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      
      // Batch write kullanarak performansı artırıyoruz
      const batch = db.batch();
      
      for (const item of feed.items.slice(0, 15)) {
        // DUPLICATE KONTROL: Linkin base64 halini ID yapıyoruz
        const docId = Buffer.from(item.link).toString("base64").substring(0, 150);
        
        const title = item.title || "Haber";
        const rawContent = item['content:encoded'] || item.content || item.description || "";
        let desc = rawContent.replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, ' ').trim();
        
        if (desc.length < 20) desc = `${title}. Detaylar için tıklayınız.`;

        // KATEGORİZASYON
        let category = "Gündem";
        const lookText = (title + " " + desc).toLowerCase();
        if (lookText.match(/ekonomi|dolar|euro|altın|borsa|faiz|fiyat|zam|maaş/)) category = "Ekonomi";
        else if (lookText.match(/spor|maç|futbol|basketbol|gol|lig|derbi|transfer/)) category = "Spor";
        else if (lookText.match(/teknoloji|iphone|yazılım|ai|yapay zeka|robot/)) category = "Teknoloji";
        else if (lookText.match(/dünya|abd|avrupa|rusya|ukrayna|israil/)) category = "Dünya";
        else if (lookText.match(/sağlık|doktor|hastane|ilaç|grip|kanser/)) category = "Sağlık";

        // GÖRSEL BULMA
        let img = item.enclosure?.url || item.image?.url;
        if (!img) {
          const match = rawContent.match(/<img[^>]+src="([^">]+)"/);
          if (match) img = match[1];
        }

        const newsData = {
          title: title.substring(0, 200),
          description: desc.substring(0, 300),
          url: item.link,
          image: img || "https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=800&q=80",
          source: source.name,
          category: category,
          publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = newsCollection.doc(docId);
        batch.set(docRef, newsData, { merge: true });
        totalSaved++;
      }
      
      await batch.commit();
    } catch (e) {
      console.error(`${source.name} hatası:`, e.message);
    }
  }

  // --- TEMİZLİK: 24 saatten eski haberleri silebilirsiniz (Opsiyonel) ---
  return totalSaved;
}
