const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { syncNews } = require("./newsSync");

admin.initializeApp();
const db = admin.firestore();

exports.fetchNewsHttp = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Accept");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const result = await syncNews(db);
    res
      .status(200)
      .send(`Sistem basariyla calisti. ${result.totalSaved} haber eklendi/guncellendi.`);
  } catch (error) {
    res.status(500).send(`Hata: ${error.message}`);
  }
});
