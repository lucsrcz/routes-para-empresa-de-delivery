// ═══════════════════════════════════════════════════════════
// CONFIGURAÇÃO CENTRALIZADA (PROJETO ROUTES)
// ═══════════════════════════════════════════════════════════

const CONFIG = {
  // Firebase Config (Pode ser movido para env vars em build complexo)
  firebase: {
    projectId: "rotas-cabun-app",
    appId: "1:1017676204969:web:226223216f8dde86a752b8",
    storageBucket: "rotas-cabun-app.firebasestorage.app",
    apiKey: "AIzaSyCwFuaNuzw50bn9CV2RnP3xTx8TNcFr6D4",
    authDomain: "rotas-cabun-app.firebaseapp.com",
    messagingSenderId: "1017676204969",
    measurementId: "G-YDQLXK9YHY"
  },
  
  // URL do Backend (Mude para a URL de produção quando disponível)
  apiUrl: window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://seu-backend-producao.com", // TODO: Atualizar após deploy
    
  version: "1.2.0-senior"
};

// Congelar para evitar modificações acidentais
Object.freeze(CONFIG);
Object.freeze(CONFIG.firebase);

export default CONFIG;
