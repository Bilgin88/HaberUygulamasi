import { initializeApp } from "firebase/app";
import { getFirestore, initializeFirestore } from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";

// Sizin Firebase ayarlarınız (Haber Uygulaması - ff231)
const firebaseConfig = {
  apiKey: "AIzaSyCuJs8SldMysjCyveczJbLsZTrL_9ZWb7w",
  authDomain: "haberuygulamasi-ff231.firebaseapp.com",
  projectId: "haberuygulamasi-ff231",
  storageBucket: "haberuygulamasi-ff231.firebasestorage.app",
  messagingSenderId: "579445461982",
  appId: "1:579445461982:web:ba3a68c487fc23c22f434f",
  measurementId: "G-P8GX4YWDL7"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// --- BAĞLANTI SORUNU ÇÖZÜMÜ ---
// Firestore bağlantısını WebSocket yerine Long Polling ile zorluyoruz.
// Bu, "Failed to get document because the client is offline" hatasını çözer.
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  useFetchStreams: false
});
