const admin = require("firebase-admin");
const { syncNews } = require("../newsSync");

function loadCredentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT env variable is required.");
  }

  return JSON.parse(raw);
}

async function main() {
  const credentials = loadCredentials();

  admin.initializeApp({
    credential: admin.credential.cert(credentials),
  });

  const result = await syncNews(admin.firestore());
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
