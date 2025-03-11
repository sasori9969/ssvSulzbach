import { initializeApp } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyBZSA1sTF9PNVEPLC5_Kxk8MML_QtgNfjE",
    authDomain: "schuetzenverein-519a6.firebaseapp.com",
    projectId: "schuetzenverein-519a6",
    storageBucket: "schuetzenverein-519a6.appspot.com",
    messagingSenderId: "469364345310",
    appId: "1:469364345310:web:a7a7f2c33e92d40a52b54f"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { db };
