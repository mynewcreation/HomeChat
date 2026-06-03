// ─────────────────────────────────────────────────────────────
//  FIREBASE CONFIGURATION
//  1. Go to https://console.firebase.google.com
//  2. Create a project (or use existing)
//  3. Click "Add app" → Web (</>)
//  4. Copy your firebaseConfig object values below
//  5. In Firebase console → Build → Firestore Database → Create database (start in test mode)
// ─────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyC6fdObfqq8r8hoIwYXsqfvMyxg9vNuwXM",
  authDomain: "pconnect-9e7db.firebaseapp.com",
  projectId: "pconnect-9e7db",
  storageBucket: "pconnect-9e7db.firebasestorage.app",
  messagingSenderId: "335047317723",
  appId: "1:335047317723:web:d5d4e773dbf094617794fe",
  measurementId: "G-3C8NJ07RY9"
};
// Initialize Firebase
firebase.initializeApp(firebaseConfig);

const db = firebase.firestore();
const storage = firebase.storage();



