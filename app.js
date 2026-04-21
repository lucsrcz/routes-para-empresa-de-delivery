import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, serverTimestamp, query, orderBy, limit, onSnapshot, doc, updateDoc, deleteDoc, getDoc, setDoc, where, writeBatch } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { getDatabase, ref as rtdbRef, set as rtdbSet, onValue, off } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";

const firebaseConfig = {
  projectId: "rotas-cabun-app",
  appId: "1:1017676204969:web:226223216f8dde86a752b8",
  storageBucket: "rotas-cabun-app.firebasestorage.app",
  apiKey: "AIzaSyCwFuaNuzw50bn9CV2RnP3xTx8TNcFr6D4",
  authDomain: "rotas-cabun-app.firebaseapp.com",
  messagingSenderId: "1017676204969",
  measurementId: "G-YDQLXK9YHY",
  databaseURL: "https://rotas-cabun-app-default-rtdb.firebaseio.com"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const rtdb = getDatabase(app);
let currentUser = null;
let allLocations = [];
let builderSelectedPoints = [];
let userCoords = null;
let driverMissionsUnsubscribe = null;

// Sanitização XSS — escapa HTML em conteúdo dinâmico
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// Sanitização de URL — previne injeção de javascript: em links
function sanitizeUrl(url) {
  if (!url) return '';
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? url : ''; }
  catch(e) { return ''; }
}

// Tema: persistência entre login e app
window.toggleAppTheme = function() {
  document.body.classList.toggle('dm');
  const isDark = document.body.classList.contains('dm');
  localStorage.setItem('routes-theme', isDark ? 'dark' : 'light');
};

// Carregar tema salvo ao abrir
(function() {
  const saved = localStorage.getItem('routes-theme');
  if (saved === 'dark') {
    document.body.classList.add('dm');
  }
})();

navigator.geolocation.getCurrentPosition(async p => {
  userCoords = { lat: p.coords.latitude, lng: p.coords.longitude };
  updateWeather(userCoords.lat, userCoords.lng);
}, () => console.log("Sem acesso ao GPS"));

async function updateWeather(lat, lon) {
  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
    const data = await response.json();
    if (data && data.current_weather) {
      const temp = Math.round(data.current_weather.temperature);
      const isDay = data.current_weather.is_day === 1;
      const tempVal = document.querySelector('.temp-val');
      const tempLoc = document.querySelector('.temp-loc');
      const tempIcon = document.querySelector('.temp-icon');
      
      if (tempVal) tempVal.textContent = `${temp}°C`;
      if (tempIcon) {
        tempIcon.textContent = isDay ? '☀' : '🌙';
        tempIcon.style.color = isDay ? '#FFD700' : '#E2EEF8';
        tempIcon.style.opacity = '1';
        tempIcon.style.textShadow = '0 0 10px rgba(0,0,0,0.1)';
      }
      
      // Tentativa de pegar nome da cidade via geocoding reverso simples
      try {
        const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
        const geoData = await geoRes.json();
        if (tempLoc && geoData.address) {
          const city = geoData.address.city || geoData.address.town || geoData.address.village || "Sua Localização";
          const state = geoData.address.state || "";
          tempLoc.textContent = `${city}${state ? ', ' + state : ''}`;
        }
      } catch(e) { console.warn("Erro ao buscar nome da cidade:", e); }
    }
  } catch (error) {
    console.error("Erro ao atualizar clima:", error);
  }
}

// ══════════════════════════════════════════════════════════
// OSRM UTILITY — cálculo de trajeto em background
// ══════════════════════════════════════════════════════════
window.calculateOSRMBackground = async function(routeRef, points) {
  try {
    if (!points || points.length === 0) return;
    
    // Coletar coordenadas dos pontos (filtrando nulos)
    const validPoints = points.filter(p => p.lat && p.lng);
    if (validPoints.length === 0) return;

    // Tentar obter localização atual se não estiver carregada (fallback para rotas mais precisas)
    if (!window.userCoords) {
      try {
        const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, {timeout: 3000, enableHighAccuracy: true}));
        window.userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch(e) { /* sem GPS ou timeout, continua com o que tem */ }
    }

    let coords = [];
    if (window.userCoords) {
      coords.push(`${window.userCoords.lng},${window.userCoords.lat}`);
    }
    validPoints.forEach(p => coords.push(`${p.lng},${p.lat}`));

    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coords.join(';')}?overview=full&geometries=polyline`;

    const res = await fetch(osrmUrl);
    const data = await res.json();

    if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
      const route = data.routes[0];
      const dk = (route.distance / 1000).toFixed(1);
      const tm = Math.round(route.duration / 60);

      await updateDoc(routeRef, {
        distance: dk,
        time: tm,
        polyline: route.geometry || ""
      });
      console.log("✅ Detalhes da rota atualizados via OSRM:", dk + "km", tm + "min");
    }
  } catch(e) {
    console.warn("Falha no cálculo background OSRM:", e);
  }
};

// Utility para decodificar polylines do Google/OSRM
window.decodePolyline = function(str, precision = 5) {
  let index = 0, lat = 0, lng = 0, coordinates = [], shift = 0, result = 0, byte = null, latitude_change, longitude_change, factor = Math.pow(10, precision);
  while (index < str.length) {
    byte = null; shift = 0; result = 0;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
    shift = result = 0;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += latitude_change; lng += longitude_change;
    coordinates.push([lat / factor, lng / factor]);
  }
  return coordinates;
};


window.userRole = "driver"; // Padrão global

// ══════════════════════════════════════════════════════════
// GLOBAL FAIL-SAFE LOADER
// ══════════════════════════════════════════════════════════
(function() {
  const hideLdr = () => {
    const ldr = document.getElementById('appLoader');
    if (ldr) ldr.style.display = 'none';
    const shl = document.getElementById('shell');
    if (shl) shl.style.visibility = 'visible';
  };
  window._loaderFailSafe = setTimeout(() => {
    console.warn("Global Fail-safe: Excedido tempo de inicialização.");
    hideLdr();
  }, 10000);
})();

// ══════════════════════════════════════════════════════════
// ROLE-BASED UI — controla o que admin e driver vêem
// ══════════════════════════════════════════════════════════

async function applyRoleUI() {
  console.log("Seu nível de acesso detectado:", window.userRole);
  
  const adminPanel = document.getElementById('adminPanel');
  const driverPanel = document.getElementById('driverPanel');
  const adminHubBtn = document.getElementById('adminHubBtn');
  const fleetManageBtn = document.getElementById('fleetManageBtn');
  const bottomNavAdmin = document.getElementById('bottomNavAdmin');
  const bottomNavDriver = document.getElementById('bottomNavDriver');
  const adminArea = document.getElementById('adminDriverArea');
  const dailyRouteCard = document.getElementById('dailyRouteCard');
  const adminFleetCard = document.getElementById('adminFleetCard');
  const fleetStatusDesc = document.getElementById('fleetStatusDesc');
  
  if (window.userRole === "admin") {
    // ═══ ADMIN VIEW ═══
    if (adminPanel) adminPanel.style.display = '';
    if (driverPanel) driverPanel.style.display = 'none';
    if (adminHubBtn) adminHubBtn.style.display = 'flex';
    if (fleetManageBtn) fleetManageBtn.style.display = 'flex';
    const liveSpyBtn = document.getElementById('liveSpyBtn');
    if (liveSpyBtn) liveSpyBtn.style.display = 'flex';
    if (bottomNavAdmin) bottomNavAdmin.style.display = '';
    if (bottomNavDriver) bottomNavDriver.style.display = 'none';
    if (adminArea) adminArea.style.display = 'flex';
    if (dailyRouteCard) dailyRouteCard.style.display = ''; // Show card with new purpose
    if (adminFleetCard) adminFleetCard.style.display = 'none';
    const adminMsg = document.getElementById('adminCardMessage');
    if (adminMsg) adminMsg.style.display = 'block';
    
    // Repurpose the card for Admin: "Rotas Futuras"
    const drcTitle = document.getElementById('drcTitle');
    const drcDate = document.getElementById('drcDate');
    if (drcTitle) drcTitle.textContent = 'Rotas Futuras';
    if (drcDate) drcDate.textContent = 'Programe rotas para seus motoristas';
    
    // Populate driver radio list for route assignment in Builder
    window._fleetDrivers = [];
    try {
      const q = query(collection(db, "users"), where("adminId", "==", window.companyId));
      const querySnapshot = await getDocs(q).catch(e => {
        console.warn("Falha ao buscar motoristas (index possível?):", e);
        return { empty: true, forEach: () => {} };
      });
      const driverListEl = document.getElementById('builderDriverList');
      window._selectedDriverUid = '';

      if (driverListEl) {
        driverListEl.innerHTML = '';
        
        // Removemos a opção "Para mim (Admin)" a pedido do usuário
        window._selectedDriverUid = ''; // default empty


        querySnapshot.forEach((docSnap) => {
          const u = docSnap.data();
          if (u.role === "driver") {
            const displayName = u.apelido || u.nome || 'Sem nome';
            const initial = displayName.charAt(0).toUpperCase();
            window._fleetDrivers.push({uid: docSnap.id, nome: u.nome, email: u.email, apelido: u.apelido || ''});
            
            const label = document.createElement('label');
            label.className = 'bdr-item';
            label.dataset.uid = docSnap.id;
            label.dataset.name = displayName;
            
            label.innerHTML = `
              <input type="radio" name="driverRadio" value="${docSnap.id}" class="bdr-radio"/>
              <div class="bdr-avatar">${initial}</div>
              <div class="bdr-info">
                <div class="bdr-name" style="font-size:15px; font-weight:bold; color:#1A6BAF;">${escapeHTML(displayName)}</div>
                <div class="bdr-email" style="font-size:12px; color:#7f8c8d;">${escapeHTML(u.email || '')}</div>
              </div>
              <div style="flex-shrink: 0; display:flex; align-items:center; gap:8px;">
                <span style="font-size: 10px; background: #27ae60; color: #fff; padding: 4px 12px; border-radius: 12px; font-weight: bold;">Ativo</span>
                <span class="bdr-dot"></span>
              </div>
            `;
            label.onclick = (e) => { e.preventDefault(); window.selectBuilderDriver(docSnap.id); };
            driverListEl.appendChild(label);
          }
        });
        
        if (fleetStatusDesc) {
          const count = window._fleetDrivers.length;
          fleetStatusDesc.textContent = count > 0 
            ? `${count} motorista${count > 1 ? 's' : ''} na frota`
            : 'Adicione motoristas';
        }
        
        // Auto-selecionar o primeiro motorista da lista, se houver
        if (window._fleetDrivers.length > 0 && !window._selectedDriverUid) {
          window.selectBuilderDriver(window._fleetDrivers[0].uid);
        }
      }
    } catch(e) {
      console.warn("Erro ao carregar lista de motoristas em applyRoleUI:", e);
    }

    // Cancel old driver listeners
    if (driverMissionsUnsubscribe) {
      driverMissionsUnsubscribe();
      driverMissionsUnsubscribe = null;
    }

  } else {
    // ═══ DRIVER VIEW ═══
    if (adminPanel) adminPanel.style.display = 'none';
    if (driverPanel) driverPanel.style.display = '';
    if (adminHubBtn) adminHubBtn.style.display = 'none';
    if (fleetManageBtn) fleetManageBtn.style.display = 'none';
    if (bottomNavAdmin) bottomNavAdmin.style.display = 'none';
    if (bottomNavDriver) bottomNavDriver.style.display = '';
    if (adminArea) adminArea.style.display = 'none';
    if (dailyRouteCard) dailyRouteCard.style.display = ''; // Show route card
    if (adminFleetCard) adminFleetCard.style.display = 'none'; // Hide fleet card
    
    // Start listening for driver missions
    loadDriverMissions();
  }
}

// ══════════════════════════════════════════════════════════
// DRIVER: carregar missões recebidas em tempo real
// ══════════════════════════════════════════════════════════

function loadDriverMissions() {
  if (!currentUser) return;
  
  // Listen to the driver's own history collection (missions sent by admin)
  const qMissions = query(
    collection(db, "users", currentUser.uid, "history"),
    orderBy("createdAt", "desc")
  );

  driverMissionsUnsubscribe = onSnapshot(qMissions, (snapshot) => {
    const list = document.getElementById('driverMissionsList');
    if (!list) return;
    
    list.innerHTML = '';
    const activeRouteContainer = document.getElementById('driverActiveRoute');

    if (snapshot.empty) {
      list.innerHTML = `
        <div style="padding: 30px 20px; text-align: center;">
          <div style="font-size: 40px; margin-bottom: 12px; opacity: 0.5;">📭</div>
          <div class="text-dark-auto" style="font-size: 13px; font-weight: 700; margin-bottom: 4px;">Nenhuma rota ainda</div>
          <div style="font-size: 11px; color: var(--pr-text-muted);">Quando seu admin criar uma rota para você, ela aparecerá aqui.</div>
        </div>
      `;
      if (activeRouteContainer) {
        activeRouteContainer.innerHTML = `<div style="padding: 15px; text-align: center; font-size: 11px; color: var(--pr-text-muted); opacity: 0.6;">Nenhuma rota ativa no momento</div>`;
      }
      
      const dailyRouteCard = document.getElementById('dailyRouteCard');
      if (dailyRouteCard) {
        window.currentActiveRouteUrl = null;
        document.getElementById('drcDate').textContent = "Nenhuma rota pendente.";
        document.getElementById('drcLinkText').textContent = "—";
      }
      return;
    }

    let pendingOrActiveRoute = null;

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const missionId = docSnap.id;
      const status = data.status || "Pendente";
      
      let stColor = status === "Pendente" ? "#e67e22" : (status === "Concluída" ? "#27ae60" : (status === "Em Rota" ? "#1A6BAF" : "#2196f3"));
      let stIcon = status === "Pendente" ? "⏳" : (status === "Concluída" ? "✅" : (status === "Em Rota" ? "🚚" : "🚗"));
      
      const stopsCount = data.stopsCount || 0;
      const distance = data.distance || "—";
      const time = data.time || "—";
      const mapsUrl = sanitizeUrl(data.mapsUrl);
      
      // Track first pending/active route for sidebar preview
      if ((status === "Pendente" || status === "Em Rota") && !pendingOrActiveRoute) {
        pendingOrActiveRoute = { data, missionId, status, stColor, stIcon };
      }

      // Build stop names
      let stopNames = "";
      if (data.points && data.points.length > 0) {
        stopNames = data.points.map((p, i) => `${i+1}. ${p.name || 'Local'}`).join(" → ");
      }
      
      let startedTimeHTML = '';
      if (data.startedAt && data.startedAt.toDate) {
        const dObj = data.startedAt.toDate();
        startedTimeHTML = `<span style="color:#2196f3; font-weight:600; background:rgba(33, 150, 243, 0.1); padding:2px 6px; border-radius:4px;">⏱ Saída: ${dObj.toLocaleDateString('pt-BR')} às ${dObj.toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}</span>`;
      }
      
      const card = document.createElement('div');
      card.style.cssText = "background: var(--pr-surface); border: 1px solid var(--pr-border); border-radius: 12px; padding: 14px; border-left: 4px solid " + stColor + "; transition: transform 0.15s;";
      card.onmouseover = function() { this.style.transform = 'translateX(3px)'; };
      card.onmouseout = function() { this.style.transform = 'translateX(0)'; };
      
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div class="text-dark-auto" style="font-size: 13px; font-weight: 700;">${stIcon} Rota #${missionId.substring(0,6)}</div>
          <span style="font-size: 10px; background: ${stColor}; color: #fff; padding: 2px 8px; border-radius: 10px; font-weight: bold;">${status}</span>
        </div>
        ${data.assignedByName ? `<div style="font-size: 10px; color: var(--pr-blue-mid); font-weight: 600; margin-bottom: 6px;">📨 Enviada por: ${escapeHTML(data.assignedByName)}</div>` : ''}
        <div style="font-size: 11px; color: var(--pr-text-muted); margin-bottom: 6px; line-height: 1.5;">${escapeHTML(stopNames) || 'Sem detalhes'}</div>
        <div style="display: flex; gap: 12px; flex-wrap: wrap; font-size: 10px; color: var(--pr-text-muted); margin-bottom: 10px;">
          <span>📍 ${stopsCount} paradas</span>
          ${startedTimeHTML}
        </div>
        <div style="display: flex; gap: 6px;">
          ${mapsUrl ? `<a href="${mapsUrl}" target="_blank" onclick="window.startMission('${missionId}')" style="flex: 1; display: block; background: var(--pr-blue-dark); color: #fff; text-decoration: none; text-align: center; padding: 8px; border-radius: 8px; font-size: 11px; font-weight: 600; transition: opacity 0.15s;" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'">🗺 Maps</a>` : ''}
          ${status !== "Concluída" ? `<button onclick="event.stopPropagation(); window.finishMission('${missionId}')" style="flex-shrink: 0; background: #27ae60; color: #fff; border: none; padding: 8px 14px; border-radius: 8px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: inherit; transition: opacity 0.15s;" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'">✅ Concluir</button>` : ''}
        </div>
      `;
      
      list.appendChild(card);
    });

    // Update sidebar "Rota Ativa" section with first pending route
    if (activeRouteContainer) {
      if (pendingOrActiveRoute) {
        const d = pendingOrActiveRoute.data;
        const mid = pendingOrActiveRoute.missionId;
        const stc = pendingOrActiveRoute.stColor;
        const sti = pendingOrActiveRoute.stIcon;
        const stopNames = (d.points || []).map(p => p.name || 'Local').join(' → ');
        const dist = d.distance || '—';
        const tm = d.time || '—';
        activeRouteContainer.innerHTML = `
          <div style="background: var(--pr-surface); border: 1px solid var(--pr-border); border-radius: 10px; padding: 12px; border-left: 3px solid ${stc};">
            <div class="text-dark-auto" style="font-size: 12px; font-weight: 700; margin-bottom: 6px;">${sti} Rota #${mid.substring(0,6)}</div>
            ${d.assignedByName ? `<div style="font-size: 9px; color: var(--pr-blue-mid); font-weight: 600; margin-bottom: 5px;">📨 ${escapeHTML(d.assignedByName)}</div>` : ''}
            <div style="font-size: 10px; color: var(--pr-text-muted); margin-bottom: 8px; line-height: 1.4;">${escapeHTML(stopNames)}</div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap; font-size: 9px; color: var(--pr-text-muted); margin-bottom: 10px;">
              <span>📍 ${d.stopsCount || 0} paradas</span>
              ${d.startedAt && d.startedAt.toDate ? `<span style="color:#2196f3; font-weight:600; background:rgba(33,150,243,0.1); padding:2px 6px; border-radius:4px;">⏱ Saída: ${d.startedAt.toDate().toLocaleDateString('pt-BR')} às ${d.startedAt.toDate().toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'})}</span>` : ''}
            </div>
            <div style="display: flex; gap: 6px;">
              ${d.mapsUrl ? `<a href="${d.mapsUrl}" target="_blank" onclick="window.startMission('${mid}')" style="flex:1; display:block; background:var(--pr-blue-dark); color:#fff; text-decoration:none; text-align:center; padding:7px; border-radius:7px; font-size:10px; font-weight:600;">🗺 Maps</a>` : ''}
              <button onclick="event.stopPropagation(); window.finishMission('${mid}')" style="flex:1; background:#27ae60; color:#fff; border:none; padding:7px; border-radius:7px; font-size:10px; font-weight:600; cursor:pointer; font-family:inherit;">✅ Concluir</button>
            </div>
          </div>
        `;
      } else {
        activeRouteContainer.innerHTML = `<div style="padding: 15px; text-align: center; font-size: 11px; color: var(--pr-text-muted); opacity: 0.6;">✅ Todas as rotas concluídas!</div>`;
      }
    }
    
    // Update daily route card
    const dailyRouteCard = document.getElementById('dailyRouteCard');
    if (dailyRouteCard) {
      if (pendingOrActiveRoute) {
        window.currentActiveRouteUrl = pendingOrActiveRoute.data.mapsUrl;
        window.currentActiveMissionId = pendingOrActiveRoute.missionId; // Save ID to update status if opened from here
        document.getElementById('drcDate').textContent = pendingOrActiveRoute.data.stopsCount + " Paradas";
        document.getElementById('drcLinkText').textContent = pendingOrActiveRoute.data.mapsUrl ? "maps.app.goo.gl" : "Sem link";
      } else {
        window.currentActiveRouteUrl = null;
        window.currentActiveMissionId = null;
        document.getElementById('drcDate').textContent = "Todas as rotas concluídas.";
        document.getElementById('drcLinkText').textContent = "—";
      }
    }
  });
}

// --- UNIFIED STATUS HELPER ---
window.updateRouteStatus = async function(missionId, status, extraData = {}) {
  if (!currentUser || !missionId) return;
  
  const updatePayload = {
    status: status,
    ...extraData
  };

  try {
    // 1. Update Subcollection (History)
    await updateDoc(doc(db, "users", currentUser.uid, "history", missionId), updatePayload);
    
    // 2. Update Parent User Doc (Denormalization to trigger Admin Hub Real-time)
    await updateDoc(doc(db, "users", currentUser.uid), {
      currentStatus: status,
      lastStatusUpdate: serverTimestamp()
    });
    
    console.log(`Status sincronizado: ${status}`);
  } catch(e) {
    console.warn("Erro ao sincronizar status:", e);
    throw e;
  }
};

window.startMission = async function(missionId) {
  try {
    await window.updateRouteStatus(missionId, "Em Rota", { startedAt: serverTimestamp() });
  } catch(e) {
    console.warn("Erro ao iniciar rota:", e);
  }
};

window.finishMission = async function(missionId) {
  if (confirm("Deseja marcar esta rota como Concluída?")) {
    try {
      await window.updateRouteStatus(missionId, "Concluída", { completedAt: serverTimestamp() });
    } catch(e) {
      alert("Erro ao concluir: " + e.message);
    }
  }
};

window.openDriverRoutesModal = function() {
  document.getElementById('driverRoutesModal').classList.add('active');
};

window.closeDriverRoutesModal = function() {
  document.getElementById('driverRoutesModal').classList.remove('active');
};

window.renameDriver = async function(uid, oldName) {
  const newName = prompt("Digite o nome desse motorista:", oldName || "");
  if (newName !== null && newName.trim() !== "") {
    try {
      await updateDoc(doc(db, "users", uid), { nome: newName.trim() });
      loadAdminHubData();
      applyRoleUI();
    } catch(e) {
      alert("Erro: " + e.message);
    }
  }
}

// ══════════════════════════════════════════════════════════
// AUTENTICAÇÃO E CONFIGURAÇÃO DE ROLE
// ══════════════════════════════════════════════════════════

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // Somente redirecionar se realmente não houver usuário após um pequeno delay para evitar loops
    setTimeout(() => {
      if (!auth.currentUser) {
        console.log("Nenhum usuário detectado. Redirecionando para login...");
        window.location.href = "routes_login.html";
      }
    }, 1000);
  } else {
    currentUser = user;
    
    // Configuração de Identidade e Papel (Role)
    try {
      const userRef = doc(db, "users", currentUser.uid);
      let userSnap = await getDoc(userRef);
      let udata = null;
      
      if (!userSnap.exists()) {
        // Fallback for completely missing document (like SSO login without invite)
        window.userRole = "pending";
        window.adminId = null;
        await setDoc(userRef, {
          email: currentUser.email,
          nome: currentUser.displayName || '',
          role: "pending",
          createdAt: serverTimestamp()
        });
        udata = { role: "pending" };
      } else {
        udata = userSnap.data();
        window.userRole = udata.role || "pending";
        window.adminId = udata.adminId || null;
        window.companyId = window.adminId || currentUser.uid;
        
        if (udata.inviteCodeCache) {
          document.getElementById('rpDriverInput').value = udata.inviteCodeCache;
        }
      }

      function hideLoader() {
        const loader = document.getElementById('appLoader');
        if (loader) loader.style.display = 'none';
        const shell = document.getElementById('shell');
        if (shell) shell.style.visibility = 'visible';
        if (window._loaderFailSafe) clearTimeout(window._loaderFailSafe);
      }


      // ══════════════════════════════════════════════════════
      // CONVITE VIA URL — funciona para QUALQUER estado de conta
      // Se o motorista já tem conta e clica no link, vincula mesmo assim
      // ══════════════════════════════════════════════════════
      const urlParams = new URLSearchParams(window.location.search);
      const conviteUrl = urlParams.get('convite');
      if (conviteUrl) {
        try {
          const inviteRef = doc(db, "invites", conviteUrl);
          const inviteSnap = await getDoc(inviteRef);
          if (inviteSnap.exists() && !inviteSnap.data().usado) {
            const inviteData = inviteSnap.data();
            await updateDoc(userRef, {
              role: 'driver',
              adminId: inviteData.adminId,
              inviteCodeCache: null
            });
            await updateDoc(inviteRef, { usado: true });
            window.userRole = 'driver';
            window.adminId = inviteData.adminId;
            window.companyId = inviteData.adminId;

            // Limpar o ?convite= da URL sem recarregar
            window.history.replaceState({}, document.title, window.location.pathname);

            alert(`✨ Conta vinculada automaticamente à frota do Administrador!`);
            hideLoader();
            applyRoleUI();
            loadLocations();
            return;
          }
        } catch(err) {
          console.warn("Erro ao processar convite da URL:", err);
        }
      }

      // ══════════════════════════════════════════════════════
      // CONVITE VIA CACHE (salvo durante o cadastro)
      // ══════════════════════════════════════════════════════
      if (window.userRole === "pending") {
        if (udata && udata.inviteCodeCache) {
          try {
            const inviteRef = doc(db, "invites", udata.inviteCodeCache);
            const inviteSnap = await getDoc(inviteRef);
            if (inviteSnap.exists()) {
              const inviteData = inviteSnap.data();
              if (!inviteData.usado) {
                await updateDoc(userRef, {
                  role: 'driver',
                  adminId: inviteData.adminId,
                  inviteCodeCache: null
                });
                await updateDoc(inviteRef, { usado: true });
                window.userRole = 'driver';
                window.adminId = inviteData.adminId;
                
                alert(`✨ Conta vinculada automaticamente à frota via Convite!`);
                hideLoader();
                applyRoleUI();
                loadLocations();
                return;
              }
            }
          } catch(err) {
            console.warn("Erro ao vincular convite automaticamente:", err);
          }
        }

        hideLoader();
        document.getElementById('rolePickerModal').classList.add('active');
        return; // Pause UI setup until role is chosen
      }

      applyRoleUI();
      hideLoader();
    } catch(err) {
      console.warn("Erro ao configurar permissões do usuário", err);
      const loader = document.getElementById('appLoader');
      if (loader) loader.style.display = 'none';
    }

    // Load locations for admin or driver
    loadLocations();

    // Iniciar sistema de despacho automático de rotas agendadas
    window.startScheduledRouteDispatcher();
  }
});

// Generate Admin Invite
window.generateAdminInviteToken = async function() {
  if (confirm("Gerar uma nova chave secreta gerencial?\nEsta chave poderá ser usada UMA vez.")) {
    try {
      const code = 'ADM-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      await setDoc(doc(db, "admin_keys", code), {
        usado: false,
        createdBy: window.companyId || currentUser.uid,
        createdAt: serverTimestamp()
      });
      document.getElementById('adminInviteResult').style.display = 'block';
      document.getElementById('adminInviteKeyText').innerText = code;
    } catch (e) {
      console.error(e);
      alert("Erro ao criar chave. Você tem permissão?");
    }
  }
};

// Role Picker Submission (Post-Login)
window.submitRoleSelection = async function(role) {
  const UID = currentUser.uid;

  try {
    if (role === 'owner') {
      const batch = writeBatch(db);
      batch.update(doc(db, "users", UID), {
        role: 'admin',
        inviteCodeCache: null,
        adminId: null
      });
      await batch.commit();

      window.userRole = 'admin';
      window.adminId = null;
      window.companyId = currentUser.uid;
      
      document.getElementById('rolePickerModal').classList.remove('active');
      applyRoleUI();
      loadLocations();
      alert("Frota criada com sucesso! Bem-vindo(a).");
      return;

    } else if (role === 'admin') {
      const secretInput = document.getElementById('rpAdminInput').value.trim().toUpperCase();
      if (!secretInput) {
        alert("Preencha a chave secreta de Administrador!");
        return;
      }
      
      const keyRef = doc(db, "admin_keys", secretInput);
      const keySnap = await getDoc(keyRef);
      if (!keySnap.exists()) {
        alert("Chave inexistente!");
        return;
      }
      if (keySnap.data().usado) {
        alert("Esta chave já foi usada e cancelada!");
        return;
      }
      
      const originalAdminUid = keySnap.data().createdBy;
      const isSystemKey = originalAdminUid === 'SYSTEM_SETUP';
      
      const batch = writeBatch(db);
      // Queima a chave atrelada a este usuário, validando a rule atomica
      batch.update(keyRef, { usado: true, usedBy: UID });
      // Promove o usuário
      batch.update(doc(db, "users", UID), {
        role: 'admin',
        adminKey: secretInput,
        inviteCodeCache: null,
        adminId: isSystemKey ? null : originalAdminUid
      });

      await batch.commit();
      
      // 🔥 Deletar a chave do Firestore — sem rastros
      try { await deleteDoc(keyRef); } catch(e) { /* silencioso */ }

      window.userRole = 'admin';
      window.adminId = isSystemKey ? null : originalAdminUid;
      window.companyId = isSystemKey ? currentUser.uid : originalAdminUid;

    } else if (role === 'driver') {
      let rawInput = document.getElementById('rpDriverInput').value.trim();
      if (!rawInput) {
        alert("Cole o link de convite recebido pelo Administrador.");
        return;
      }
      
      // Extrair código do link (se for URL com ?convite=)
      let inviteCode = rawInput;
      try {
        if (rawInput.includes('convite=')) {
          const url = new URL(rawInput);
          inviteCode = url.searchParams.get('convite') || rawInput;
        }
      } catch(e) {
        // Se não for URL válida, tenta extrair com regex
        const match = rawInput.match(/convite=([a-zA-Z0-9\-]+)/);
        if (match) inviteCode = match[1];
      }

      const inviteRef = doc(db, "invites", inviteCode);
      const inviteSnap = await getDoc(inviteRef);
      if (!inviteSnap.exists()) {
        alert("Código de convite inválido.");
        return;
      }

      const inviteData = inviteSnap.data();
      if (inviteData.usado) {
        alert("Este convite já foi utilizado. Peça um novo.");
        return;
      }

      await updateDoc(doc(db, "users", UID), {
        role: 'driver',
        adminId: inviteData.adminId,
        inviteCodeCache: null
      });
      await updateDoc(inviteRef, { usado: true });

      window.userRole = 'driver';
      window.adminId = inviteData.adminId;
    }

    // Close modal and execute normal boot flow
    document.getElementById('rolePickerModal').classList.remove('active');
    applyRoleUI();
    loadLocations();
    alert("Perfil configurado com sucesso! Bem-vindo.");

  } catch(e) {
    alert("Erro na conversão de perfil: " + e.message);
  }
}

window.handleLogout = async function() {
  if(confirm("Deseja realmente sair?")) {
    try {
      if(document.getElementById('rpAdminInput')) document.getElementById('rpAdminInput').value = '';
      if(document.getElementById('rpDriverInput')) document.getElementById('rpDriverInput').value = '';
      if (driverMissionsUnsubscribe) {
        driverMissionsUnsubscribe();
        driverMissionsUnsubscribe = null;
      }
      await signOut(auth);
    } catch(e) {
      alert("Erro ao sair: " + e.message);
    }
  }
};


window.openGoogleMaps = function(e) {
  const link = document.getElementById('routeExternalLink');
  const hasRoute = link && link.href && link.href.includes("google.com/maps");
  
  if (hasRoute) {
    window.open(link.href, '_blank');
  } else {
    window.open("https://www.google.com/maps", '_blank');
  }
  
  // Previne o comportamento padrão do <a> para não abrir aba vazia
  if (e && e.preventDefault) e.preventDefault();
  return false;
};

window.openLocModal = function() {
  document.getElementById('locModal').classList.add('active');
  document.getElementById('locModalTitle').textContent = "Adicionar Local";
  document.getElementById('locEditingId').value = '';
  document.getElementById('locNameInput').value = '';
  document.getElementById('locInput').value = '';
  document.getElementById('locInput').focus();
};

window.openEditModal = function(id, name, link) {
  if (typeof window.closeSearchModal === 'function') window.closeSearchModal();
  document.getElementById('locModal').classList.add('active');
  document.getElementById('locModalTitle').textContent = "Editar Local";
  document.getElementById('locEditingId').value = id;
  document.getElementById('locNameInput').value = name || '';
  document.getElementById('locInput').value = link || '';
  document.getElementById('locNameInput').focus();
};

window.closeLocModal = function() {
  document.getElementById('locModal').classList.remove('active');
};

window.openSearchModal = function() {
  document.getElementById('searchAgendaInput').value = '';
  document.getElementById('searchModal').classList.add('active');
  renderSearchAgenda();
};

window.closeSearchModal = function() {
  document.getElementById('searchModal').classList.remove('active');
};

window.renderSearchAgenda = function() {
  const list = document.getElementById('searchList');
  const term = (document.getElementById('searchAgendaInput').value || '').toLowerCase();
  list.innerHTML = '';
  
  const filtered = allLocations.filter(loc => 
    (loc.name||'').toLowerCase().includes(term) || 
    (loc.originalInput||'').toLowerCase().includes(term)
  );

  filtered.forEach((data) => {
    const item = document.createElement('div');
    item.className = 'loc-item';
    item.style.marginBottom = '5px';
    
    const dotClass = 'dot-b';
    const icon = '📍';

    const safeName = (data.name||'').replace(/'/g, "\\'");
    const safeLink = (data.originalInput||'').replace(/'/g, "\\'");
    const hrefUrl = data.originalInput.startsWith('http') ? data.originalInput : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.originalInput)}`;

    item.innerHTML = `
      <div class="loc-dot ${dotClass}" onclick="window.open('${hrefUrl}', '_blank')" style="cursor:pointer; transition:transform 0.15s;" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'" title="Abrir no mapa">${icon}</div>
      <div class="loc-info" style="cursor:pointer;" onclick="window.open('${hrefUrl}', '_blank')" title="Pesquisar Local">
        <div class="loc-name">${escapeHTML(data.name) || 'Local Adicionado'}</div>
        <div class="loc-addr">${data.lat && data.lng ? `Coordenadas Salvas` : escapeHTML((data.originalInput||'').substring(0,40))+'...'}</div>
        ${data.isOwn === false ? `<div style="font-size:9px; color:var(--pr-blue-mid); font-weight:bold; margin-top: 2px;">📍 Da Empresa (Admin)</div>` : ''}
      </div>
      ${data.isOwn !== false ? `
      <div class="loc-actions">
         <button class="ia-btn" onclick="openEditModal('${data.id}', '${safeName}', '${safeLink}')" title="Editar">✏</button>
         <button class="ia-btn" style="color:#e06666;" onclick="deleteLocation('${data.id}')" title="Excluir">🗑</button>
      </div>` : ''}
    `;
    list.appendChild(item);
  });
  
  if (allLocations.length === 0) {
    list.innerHTML = `<div style="padding:10px;font-size:11px;color:var(--pr-text-muted);text-align:center;">Sua agenda de pesquisa está vazia. Comece adicionando locais.</div>`;
  } else if (filtered.length === 0) {
    list.innerHTML = `<div style="padding:10px;font-size:11px;color:var(--pr-text-muted);text-align:center;">Nenhum local encontrado para a sua busca.</div>`;
  }
};

window.deleteLocation = async function(id) {
  if(!currentUser) return;
  if(confirm("Tem certeza que deseja excluir este local?")) {
    try {
      await deleteDoc(doc(db, "users", currentUser.uid, "locations", id));
    } catch(e) {
      alert("Erro ao excluir: " + e.message);
    }
  }
};

window.saveLocation = async function() {
  if (!currentUser) return;
  const linkInput = document.getElementById('locInput').value.trim();
  let nameInput = document.getElementById('locNameInput').value.trim();
  const editId = document.getElementById('locEditingId').value;
  
  if(!linkInput) return alert("Por favor, digite um link ou endereço.");

  // Validação básica do input
  if(linkInput.length < 3) return alert("O endereço ou link parece muito curto. Verifique e tente novamente.");

  const btn = document.getElementById('locSaveBtn');
  btn.textContent = 'Aguarde...';
  btn.style.pointerEvents = 'none';

  let resolvedData = { lat: null, lng: null, expandedUrl: "", name: nameInput || linkInput };

  // Tentar resolver via backend (com fallback se estiver offline)
  try {
    const res = await fetch('http://localhost:3000/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: linkInput })
    });
    
    if(res.ok) {
      const data = await res.json();
      resolvedData = {
        lat: data.lat || null,
        lng: data.lng || null,
        expandedUrl: data.expandedUrl || "",
        name: nameInput || data.name || "Local Adicionado"
      };
    }
  } catch(e) {
    console.warn("Backend offline — salvando endereço diretamente.", e.message);
    // Fallback: salvar com o input bruto (sem resolução de link)
    resolvedData.name = nameInput || "Local Adicionado";
  }

  try {
    if (editId) {
      await updateDoc(doc(db, "users", currentUser.uid, "locations", editId), {
        originalInput: linkInput,
        name: resolvedData.name,
        lat: resolvedData.lat,
        lng: resolvedData.lng,
        expandedUrl: resolvedData.expandedUrl
      });
    } else {
      await addDoc(collection(db, "users", currentUser.uid, "locations"), {
        originalInput: linkInput,
        name: resolvedData.name,
        lat: resolvedData.lat,
        lng: resolvedData.lng,
        expandedUrl: resolvedData.expandedUrl,
        createdAt: serverTimestamp()
      });
    }
    closeLocModal();
  } catch(e) {
    console.error(e);
    alert("Falha ao salvar local. Detalhes: " + e.message);
  } finally {
    btn.textContent = 'Salvar Local';
    btn.style.pointerEvents = 'auto';
  }
};

function loadLocations() {
  if(!currentUser) return;
  
  if (window.userRole === "admin") {
    const q = query(collection(db, "users", window.companyId, "locations"), orderBy("name", "asc"));
    onSnapshot(q, (snapshot) => {
      allLocations = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        data.id = docSnap.id;
        data.isOwn = true;
        allLocations.push(data);
      });
      
      renderSearchAgenda();
      if(document.getElementById('builderModal') && document.getElementById('builderModal').classList.contains('active')) {
         renderBuilderLocations();
      }
    }, (error) => { console.error("Erro Locations Admin:", error); });

    const qRecent = query(collection(db, "users", currentUser.uid, "locations"), orderBy("createdAt", "desc"), limit(5));
    onSnapshot(qRecent, (snapshot) => {
      const rList = document.getElementById('recentList');
      if (!rList) return;
      rList.innerHTML = '';
      
      if(snapshot.docs.length === 0) {
        rList.innerHTML = `<div style="padding:10px;font-size:11px;color:var(--pr-text-muted);text-align:center;opacity:0.6;">Nenhuma busca recente.</div>`;
      }

      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        const item = document.createElement('div');
        item.className = 'loc-item';
        item.style.opacity = '0.7';
        item.style.marginBottom = '5px';
        
        const hrefUrl = data.originalInput.startsWith('http') ? data.originalInput : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.originalInput)}`;

        item.innerHTML = `
          <div class="loc-dot" style="background:var(--pr-bg);font-size:12px;cursor:pointer;transition:transform 0.15s;" onclick="window.open('${hrefUrl}', '_blank')" onmouseover="this.style.transform='scale(1.1)'" onmouseout="this.style.transform='scale(1)'" title="Abrir histórico">🕓</div>
          <div class="loc-info">
            <div class="loc-name">
              <a href="${hrefUrl}" target="_blank" style="color:inherit;text-decoration:none;">${escapeHTML(data.name) || 'Local Adicionado'}</a>
            </div>
            <div class="loc-addr" style="font-size:8px;">${data.lat && data.lng ? 'Coordenadas' : 'Adicionado recentemente'}</div>
          </div>
        `;
        rList.appendChild(item);
      });
    });
  } else {
    // Driver Role: Dual Listener (Own + Admin's)
    let adminLocs = [];
    let driverLocs = [];
    
    function mergeLocations() {
      allLocations = [...adminLocs, ...driverLocs];
      // Sort purely alphabetically
      allLocations.sort((a,b) => (a.name||"").localeCompare(b.name||""));
      renderSearchAgenda();
    }

    if (window.adminId) {
      const qAdmin = query(collection(db, "users", window.adminId, "locations"), orderBy("name", "asc"));
      onSnapshot(qAdmin, (snapshot) => {
        adminLocs = [];
        snapshot.forEach(docSnap => {
          const d = docSnap.data(); d.id = docSnap.id; d.isOwn = false;
          adminLocs.push(d);
        });
        mergeLocations();
      }, (error) => {
        console.error("Erro leitura Admin locations para o Driver:", error);
      });
    }

    const qDriver = query(collection(db, "users", currentUser.uid, "locations"), orderBy("name", "asc"));
    onSnapshot(qDriver, (snapshot) => {
      driverLocs = [];
      snapshot.forEach(docSnap => {
        const d = docSnap.data(); d.id = docSnap.id; d.isOwn = true;
        driverLocs.push(d);
      });
      mergeLocations();
    }, (error) => {
      console.error("Erro leitura das próprias locations (Driver):", error);
    });
  }
  // Listener para sincronizar a última rota (Dashboard)
  const qHistory = query(collection(db, "users", currentUser.uid, "history"), orderBy("createdAt", "desc"), limit(1));
  onSnapshot(qHistory, (snapshot) => {
    if(!snapshot.empty) {
      window.activeRouteId = snapshot.docs[0].id;
      const data = snapshot.docs[0].data();
      window.activeRouteData = data; // Reference for the driver modal
      
      const mD = document.getElementById('mapDist');
      const mT = document.getElementById('mapTime');
      const mS = document.getElementById('mapStops');
      if(mD) mD.textContent = (data.distance && data.distance !== "—") ? data.distance + ' km' : '—';
      if(mT) mT.textContent = (data.time && data.time !== "—") ? data.time + ' min' : '—';
      if(mS) mS.textContent = data.stopsCount || 0;
      
      // Título: "Rota de Hoje" + Visor de Status (apenas para motoristas)
      if (window.userRole !== 'admin') {
        const drcTitle = document.getElementById('drcTitle');
        const st = data.status || "Pendente";
        let stColor = st === "Pendente" ? "orange" : (st === "Concluída" ? "#27ae60" : "#1A6BAF");
        if(drcTitle) drcTitle.innerHTML = `Rota de Hoje <span style="font-size:10px; background:${stColor}; color:#fff; padding:2px 6px; border-radius:10px; margin-left:6px; font-weight:bold;">${st}</span>`;

        // Descrição: lista dos locais da rota
        const drcDate = document.getElementById('drcDate');
        if(drcDate && data.points) {
          drcDate.textContent = `${data.points.length} Paradas`;
        }
      }
      
      const rL = document.getElementById('routeStopList');
      if(rL && data.points) {
        const names = data.points.map((p, i) => `${i+1}. ${p.name || 'Local'}`).join('<br>');
        rL.innerHTML = `<strong>Última Rota:</strong><br><span style="color:var(--pr-blue-mid)">● Início: Minha Localização</span><br>${names}`;
      }

      // Sincronizar Card Flutuante
      window.currentRouteUrl = data.mapsUrl || "";

      // Link: "maps.app.goo.gl"
      const drcLinkText = document.getElementById('drcLinkText');
      if(drcLinkText) drcLinkText.textContent = "maps.app.goo.gl";

      // Dashboard
      if(data.polyline) {
        const apiKey = firebaseConfig.apiKey;
        const poly = encodeURIComponent(data.polyline);
        const staticImgUrl = `https://maps.googleapis.com/maps/api/staticmap?size=440x280&path=color:0x4285F4|weight:4|enc:${poly}&key=${apiKey}`;
        
        const previewImg = document.getElementById('routePreviewImg');
        const previewContainer = document.getElementById('routePreviewContainer');
        const actionContainer = document.getElementById('routeActionContainer');
        const externalLink = document.getElementById('routeExternalLink');
        if(previewImg) previewImg.src = staticImgUrl;
        if(previewContainer) previewContainer.style.display = 'block';
        if(actionContainer) actionContainer.style.display = 'block';
        if(externalLink) externalLink.href = data.mapsUrl || "#";
      }

      // Feedback visual no card
      const card = document.getElementById('dailyRouteCard');
      if(card) {
        card.style.transform = 'scale(1.05)';
        setTimeout(() => card.style.transform = 'scale(1)', 400);
      }
    }
  });
}



/* BUILDER MODAL LOGIC */
window.openRouteChoiceModal = function() {
  document.getElementById('routeChoiceModal').classList.add('active');
};

window.closeRouteChoiceModal = function() {
  document.getElementById('routeChoiceModal').classList.remove('active');
};

window.openBuilderModal = function() {
  builderSelectedPoints = [];
  document.getElementById('builderSearch').value = '';
  const ds = document.getElementById('builderDriverSearch');
  if (ds) ds.value = '';
  document.getElementById('builderModal').classList.add('active');
  renderBuilderSequence();
  renderBuilderLocations();
  
  // Se já houver um motorista selecionado, garantimos o visual. Se não ou for array vazio, ele fica aguardando.
  if (window._fleetDrivers && window._fleetDrivers.length > 0) {
    if (!window._selectedDriverUid) {
      window.selectBuilderDriver(window._fleetDrivers[0].uid);
    } else {
      window.selectBuilderDriver(window._selectedDriverUid);
    }
  } else {
    window._selectedDriverUid = '';
    window.updateGenerateBtn();
  }
  
  if (window.filterBuilderDrivers) {
    window.filterBuilderDrivers();
  }
};

window.closeBuilderModal = function() {
  document.getElementById('builderModal').classList.remove('active');
};

// Select driver from list in Builder
window.selectBuilderDriver = function(uid) {
  window._selectedDriverUid = uid;
  const items = document.querySelectorAll('.bdr-item');
  items.forEach(i => i.classList.toggle('selected', i.dataset.uid === uid));
  const radios = document.querySelectorAll('.bdr-radio');
  radios.forEach(r => r.checked = (r.value === uid));
  
  // Update hidden select for compatibility
  const select = document.getElementById('adminDriverSelect');
  if (select) {
    select.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = uid;
    const selectedItem = document.querySelector(`.bdr-item[data-uid="${uid}"]`);
    opt.dataset.name = selectedItem ? selectedItem.dataset.name : '';
    select.appendChild(opt);
    select.selectedIndex = 0;
  }
  window.updateGenerateBtn();
};

// Dynamic button text based on driver selection
window.updateGenerateBtn = function() {
  const genBtn = document.getElementById('mainGenerateBtn');
  if (!genBtn) return;
  const uid = window._selectedDriverUid;
  if (uid) {
    const selectedItem = document.querySelector('.bdr-item.selected');
    const driverName = selectedItem ? selectedItem.dataset.name : 'Motorista';
    genBtn.textContent = `📨 Enviar para ${driverName}`;
    genBtn.style.background = '#27ae60';
  } else {
    genBtn.textContent = '🗺 Salvar Rota';
    genBtn.style.background = '#1A6BAF';
  }
};

window.filterBuilderDrivers = function() {
  const term = (document.getElementById('builderDriverSearch').value || '').toLowerCase();
  const items = document.querySelectorAll('.bdr-item');
  items.forEach(item => {
    const name = (item.dataset.name || '').toLowerCase();
    if (name.includes(term)) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
};

window.filterBuilderLocations = function() {
  renderBuilderLocations();
};

window.renderBuilderLocations = function() {
  const container = document.getElementById('builderAvailableList');
  const term = document.getElementById('builderSearch').value.toLowerCase();
  container.innerHTML = '';
  
  const filtered = allLocations.filter(loc => 
    (loc.name||'').toLowerCase().includes(term) || 
    (loc.originalInput||'').toLowerCase().includes(term)
  );

  filtered.forEach(loc => {
    // Esconder se já estiver selecionado
    if(builderSelectedPoints.find(p => p.id === loc.id)) return;

    const item = document.createElement('div');
    item.className = 'loc-item';
    item.style.marginBottom = '4px';
    item.style.padding = '6px 10px';
    item.innerHTML = `
      <div class="loc-dot dot-b" style="cursor:pointer;" onclick="addRoutePoint('${loc.id}')">＋</div>
      <div class="loc-info" style="cursor:pointer;" onclick="addRoutePoint('${loc.id}')">
        <div class="loc-name">${escapeHTML(loc.name) || 'Endereço'}</div>
        <div class="loc-addr" style="font-size:9px;">Clique para adicionar à rota</div>
      </div>
    `;
    container.appendChild(item);
  });
  
  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding:10px;font-size:11px;color:var(--pr-text-muted);text-align:center;">Nenhum local encontrado para "${term}".</div>`;
  }
};

window.addRoutePoint = function(id) {
  const loc = allLocations.find(l => l.id === id);
  if(loc) {
    builderSelectedPoints.push(loc);
    document.getElementById('builderSearch').value = '';
    renderBuilderSequence();
    renderBuilderLocations();
  }
};

window.removeRoutePoint = function(index) {
  builderSelectedPoints.splice(index, 1);
  renderBuilderSequence();
  renderBuilderLocations();
};

window.moveRoutePoint = function(index, direction) {
  if (direction === -1 && index > 0) {
    const temp = builderSelectedPoints[index];
    builderSelectedPoints[index] = builderSelectedPoints[index - 1];
    builderSelectedPoints[index - 1] = temp;
  } else if (direction === 1 && index < builderSelectedPoints.length - 1) {
    const temp = builderSelectedPoints[index];
    builderSelectedPoints[index] = builderSelectedPoints[index + 1];
    builderSelectedPoints[index + 1] = temp;
  }
  renderBuilderSequence();
};

window.renderBuilderSequence = function() {
  const container = document.getElementById('routeSequence');
  if(builderSelectedPoints.length === 0) {
    container.innerHTML = `<div style="font-size:10px; color:var(--pr-text-muted); text-align:center; padding-top:10px;">Nenhum ponto adicionado ainda. Selecione abaixo.</div>`;
    return;
  }
  container.innerHTML = '';
  builderSelectedPoints.forEach((loc, i) => {
    const item = document.createElement('div');
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.background = 'var(--pr-surface)';
    item.style.border = '0.5px solid var(--pr-border)';
    item.style.padding = '5px 8px';
    item.style.borderRadius = '6px';
    item.style.gap = '8px';
    
    let badgeText = i + 1;
    const upBtn = i > 0 ? `<button class="ia-btn" style="width:24px; height:24px; font-size:14px; font-weight:bold; color:var(--pr-text-muted);" onclick="moveRoutePoint(${i}, -1)" title="Subir">↑</button>` : `<div style="width:24px;"></div>`;
    const downBtn = i < builderSelectedPoints.length - 1 ? `<button class="ia-btn" style="width:24px; height:24px; font-size:14px; font-weight:bold; color:var(--pr-text-muted);" onclick="moveRoutePoint(${i}, 1)" title="Descer">↓</button>` : `<div style="width:24px;"></div>`;

    item.innerHTML = `
      <div style="background:var(--pr-blue-dark); color:#fff; font-size:9px; font-weight:700; width:18px; height:18px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0;">${badgeText}</div>
      <div style="flex:1; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--pr-text); font-weight:600;">${escapeHTML(loc.name || loc.originalInput)}</div>
      <div style="display:flex; gap:2px; align-items:center;">
        ${upBtn}
        ${downBtn}
        <button class="ia-btn" style="width:20px; height:20px; font-size:11px; color:#e06666;" onclick="removeRoutePoint(${i})" title="Remover ponto">✕</button>
      </div>
    `;
    container.appendChild(item);
  });
};

window.generateManualRoute = async function() {
  const genBtn = document.getElementById('mainGenerateBtn');
  if (genBtn) {
    genBtn.textContent = "⏳ Salvando...";
    genBtn.style.pointerEvents = "none";
    genBtn.style.opacity = "0.7";
  }

  const resetBtn = () => {
    if (genBtn) {
      genBtn.style.pointerEvents = "auto";
      genBtn.style.opacity = "1";
      window.updateGenerateBtn();
    }
  };

  try {
    if(!currentUser) {
      alert("Aguarde a autenticação conectar ou faça login novamente.");
      resetBtn();
      return;
    }

    if(builderSelectedPoints.length < 1) {
      alert("Selecione pelo menos 1 ponto.");
      resetBtn();
      return;
    }
    
    // 1) Montar o link do Google Maps (SEM abrir)
    const getDeepFormat = (loc) => (loc.lat && loc.lng) ? `${loc.lat},${loc.lng}` : encodeURIComponent(loc.name || loc.originalInput);
    const lastP = builderSelectedPoints[builderSelectedPoints.length - 1];
    let mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${getDeepFormat(lastP)}&travelmode=driving`;
    if (builderSelectedPoints.length > 1) {
      const wpUrls = builderSelectedPoints.slice(0, -1).map(getDeepFormat);
      mapsUrl += `&waypoints=${wpUrls.join('%7C')}`;
    }

    // 2) Identificar para quem despachar a rota
    let targetUid = currentUser.uid;
    let targetDriverName = '';
    if (window.userRole === "admin" && window._selectedDriverUid) {
      targetUid = window._selectedDriverUid;
      const selectedCard = document.querySelector('.bdr-item.selected');
      targetDriverName = selectedCard ? selectedCard.dataset.name : 'Motorista';
    }

    // 3) Preparar dados da rota
    const routeData = {
      points: builderSelectedPoints.map(p => ({name: p.name, input: p.originalInput, lat: p.lat||null, lng: p.lng||null})),
      distance: "—", time: "—", stopsCount: builderSelectedPoints.length, 
      polyline: "",
      mapsUrl: mapsUrl,
      status: "Pendente",
      createdAt: serverTimestamp()
    };

    // Se está enviando para um motorista, salvar quem enviou
    if (targetUid !== currentUser.uid) {
      routeData.assignedBy = currentUser.uid;
      routeData.assignedByName = currentUser.displayName || currentUser.email || 'Admin';
    }

    // 4) Salvar no banco (vai disparar o listener do Firestore que atualiza o card do Usuário Alvo)
    const newRouteRef = await addDoc(collection(db, "users", targetUid, "history"), routeData);

    // 5) Feedback visual + fechar modal
    window.currentRouteUrl = mapsUrl;
    if(genBtn) genBtn.textContent = "✅ Enviado!";
    const builderModal = document.getElementById('builderModal');
    if(builderModal) builderModal.classList.remove('active');

    if (targetDriverName) {
      // Enviou para um motorista
      alert(`✅ Rota enviada com sucesso para ${targetDriverName}!\n\n📍 ${builderSelectedPoints.length} parada(s)\n🔗 O motorista já pode ver a missão no painel.`);
    }

    // 4) Tentar calcular detalhes e trajeto em BACKGROUND via OSRM
    window.calculateOSRMBackground(newRouteRef, builderSelectedPoints);

    // Reset do botão em background
    setTimeout(resetBtn, 1500);

  } catch (err) {
    console.error("Erro ao salvar rota:", err);
    alert("Erro ao salvar a rota: " + err.message);
    resetBtn();
  }
};

// ATUALIZAÇÃO DA DATA E HORA EM TEMPO REAL NO CARD FLUTUANTE
function updateCardDate() {
  const drcDate = document.getElementById('drcDate');
  if (!drcDate) return;

  // Se tem rota ativa, NÃO sobrescrever — manter os detalhes da rota
  if (window.currentRouteUrl) return;

  // Sem rota: mostrar data/hora
  const now = new Date();
  const dateOptions = { weekday: 'long', day: 'numeric', month: 'short' };
  const dateStr = now.toLocaleDateString('pt-BR', dateOptions);
  const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  drcDate.textContent = `${dateStr.charAt(0).toUpperCase() + dateStr.slice(1)} • ${timeStr}`;
}

// Função para abrir a rota ao clicar no card e MUDAR O STATUS
window.openRouteFromCard = function(evt) {
  // 1. Tenta abrir a rota do cenário "Painel Driver" (se houver a URL configurada localmente)
  if (window.currentActiveRouteUrl) {
    if (window.currentActiveMissionId) {
      window.startMission(window.currentActiveMissionId);
    }
    window.open(window.currentActiveRouteUrl, '_blank');
  } 
  // 2. Tenta abrir a rota do cenário "Painel Admin" (se gerou a rota no mesmo momento)
  else if (window.currentRouteUrl) {
    const routeUrl = window.currentRouteUrl;
    
    if (window.activeRouteId) {
      // Atualiza o banco e sincroniza com o admin
      window.updateRouteStatus(window.activeRouteId, "Em Rota").catch(e => console.warn("Falha ao sincronizar status", e));
    }

    // Logo em seguida e na mesma fração de segundo, abrimos o Maps:
    window.open(routeUrl, '_blank');
  } 
  else {
    alert("Nenhuma rota ativa no momento!");
  }
};

// Card click handler — abre fleet panel (admin) ou rota (driver)
window.handleDailyCardClick = function() {
  if (window.userRole === 'admin') {
    window.openFleetPanel();
  } else {
    if (!window.activeRouteData) {
      alert("Nenhuma rota ativa no momento!");
      return;
    }
    window.openDriverDailyRouteModal();
  }
};

window.openDriverDailyRouteModal = function() {
  const modal = document.getElementById('driverDailyRouteModal');
  const pointsContainer = document.getElementById('driverDailyRoutePoints');
  const noteContent = document.getElementById('driverDailyRouteNote');
  
  if (!modal || !pointsContainer) return;
  
  // Set note
  noteContent.textContent = window.activeRouteData.obs || "Nenhuma observação.";

  // Populate points array (we clone it to avoid mutating original activeRouteData until "Ir" is clicked)
  window.tempDriverRouteSequence = [];
  if (window.activeRouteData.points && window.activeRouteData.points.length > 0) {
    window.tempDriverRouteSequence = [...window.activeRouteData.points];
  }

  // Render points
  window.renderDriverDailyRoutePoints();
  
  modal.classList.add('active');
};

window.closeDriverDailyRouteModal = function() {
  const modal = document.getElementById('driverDailyRouteModal');
  if (modal) modal.classList.remove('active');
};

window.renderDriverDailyRoutePoints = function() {
  const c = document.getElementById('driverDailyRoutePoints');
  if (!c) return;
  c.innerHTML = "";
  
  const points = window.tempDriverRouteSequence;
  
  // We use similar styling to fleet route sorting, but adapted
  points.forEach((pt, idx) => {
    let div = document.createElement('div');
    div.style.cssText = "display: flex; align-items: center; gap: 8px; padding: 10px; background: var(--pr-bg); border-radius: 6px; border: 1px solid var(--pr-border); cursor: grab;";
    div.draggable = true;
    
    div.ondragstart = (e) => {
      window.driverRouteDragSourceIndex = idx;
      div.style.opacity = '0.5';
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/html", div.innerHTML);
    };
    
    div.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      div.style.border = '2px dashed var(--pr-blue-mid)';
    };
    
    div.ondragleave = (e) => {
      div.style.border = '1px solid var(--pr-border)';
    };
    
    div.ondrop = (e) => {
      e.preventDefault();
      div.style.border = '1px solid var(--pr-border)';
      let targetIndex = idx;
      let sourceIndex = window.driverRouteDragSourceIndex;
      
      if (sourceIndex !== targetIndex) {
        let tempSequence = [...window.tempDriverRouteSequence];
        let movedItem = tempSequence.splice(sourceIndex, 1)[0];
        tempSequence.splice(targetIndex, 0, movedItem);
        window.tempDriverRouteSequence = tempSequence;
        window.renderDriverDailyRoutePoints();
      }
    };
    
    div.ondragend = (e) => {
      div.style.opacity = '1';
      div.style.border = '1px solid var(--pr-border)';
    };

    let numb = document.createElement('div');
    numb.style.cssText = "background: var(--pr-blue-mid); color: #fff; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold;";
    numb.textContent = (idx + 1);

    let name = document.createElement('div');
    name.style.cssText = "flex: 1; font-size: 13px; font-weight: 500; color: var(--pr-text);";
    name.textContent = pt.name;

    let handle = document.createElement('div');
    handle.style.cssText = "color: var(--pr-text-muted); cursor: grab; font-size: 14px;";
    handle.innerHTML = "☰";

    div.appendChild(numb);
    div.appendChild(name);
    div.appendChild(handle);
    c.appendChild(div);
  });
};

window.startDriverDailyRoute = function() {
  if (!window.activeRouteId) {
    alert("Erro: ID da rota perdido.");
    return;
  }
  if (!window.tempDriverRouteSequence || window.tempDriverRouteSequence.length === 0) {
    alert("Nenhum ponto para rotear.");
    return;
  }

  // 1. Generate Maps URL based on tempDriverRouteSequence
  let mapsUrl = `https://www.google.com/maps/dir/?api=1`;
  
  // Last point is destination
  const lastP = window.tempDriverRouteSequence[window.tempDriverRouteSequence.length - 1];
  const wpUrls = window.tempDriverRouteSequence.slice(0, -1).map(p => encodeURIComponent(p.googleUrl || p.name));
  
  mapsUrl += `&destination=${encodeURIComponent(lastP.googleUrl || lastP.name)}&travelmode=driving`;
  if (wpUrls.length > 0) {
    mapsUrl += `&waypoints=${wpUrls.join('%7C')}`;
  }

  // 2. Mark route as "Em Rota" in Firestore and sync with Admin
  window.updateRouteStatus(window.activeRouteId, "Em Rota").catch(e => console.warn("Falha ao sincronizar status", e));

  // 3. Open URL
  window.open(mapsUrl, '_blank');

  // 4. Reload page to reset state so the driver sees the original route if they come back
  setTimeout(() => {
    window.location.reload();
  }, 100);
};

// ══════════════════════════════════════════════════════════
// FLEET PANEL — Painel flutuante de motoristas
// ══════════════════════════════════════════════════════════

window.openFleetPanel = function() {
  const panel = document.getElementById('fleetPanel');
  const card = document.getElementById('dailyRouteCard');
  const badge = document.getElementById('pdRouteDetails');
  const pill = document.getElementById('mapStatsPill');
  if (card) card.style.display = 'none';
  if (badge) badge.style.display = 'none';
  if (pill) pill.style.display = 'none';
  if (panel) {
    panel.style.display = 'flex';
    renderFleetDriverCards();
  }
};

window.closeFleetPanel = function() {
  // Limpar listener de rotas agendadas
  if (window._fpScheduledRoutesUnsub) {
    window._fpScheduledRoutesUnsub();
    window._fpScheduledRoutesUnsub = null;
  }
  // Resetar views para o estado inicial
  const driversView = document.getElementById('fpDriversView');
  const detailView = document.getElementById('fpDriverDetail');
  if (driversView) driversView.style.display = '';
  if (detailView) detailView.style.display = 'none';

  const panel = document.getElementById('fleetPanel');
  const card = document.getElementById('dailyRouteCard');
  const badge = document.getElementById('pdRouteDetails');
  const pill = document.getElementById('mapStatsPill');
  if (panel) panel.style.display = 'none';
  if (card) card.style.display = '';
  if (badge) badge.style.display = '';
  if (pill) pill.style.display = '';
};

async function renderFleetDriverCards() {
  const grid = document.getElementById('fleetPanelGrid');
  if (!grid) return;
  grid.innerHTML = '<p style="text-align:center; width:100%; font-size:12px; color:var(--pr-text-muted); padding:20px;">Carregando motoristas...</p>';

  try {
    const q = query(collection(db, "users"), where("adminId", "==", window.companyId));
    const snapshot = await getDocs(q);
    grid.innerHTML = '';

    let driverCount = 0;
    for (const docSnap of snapshot.docs) {
      const u = docSnap.data();
      if (u.role !== 'driver') continue;
      driverCount++;

      const displayName = u.apelido || u.nome || 'Sem nome';
      const initial = displayName.charAt(0).toUpperCase();
      const email = u.email || '';
      const uid = docSnap.id;

      // Obter última rota ativa (history) para exibir detalhes
      let lastRouteInfo = null;
      try {
        const hq = query(collection(db, "users", uid, "history"), orderBy("createdAt", "desc"), limit(1));
        const hSnap = await getDocs(hq);
        if (!hSnap.empty) {
          const hData = hSnap.docs[0].data();
          lastRouteInfo = {
            stops: hData.stopsCount || (hData.points ? hData.points.length : 0),
            distance: hData.distance || '—',
            time: hData.time || '—',
            status: hData.status || 'Pendente'
          };
        }
      } catch(e) { /* silencioso */ }

      // Obter rotas agendadas para determinar status
      let scheduledCountScheduled = 0;
      let scheduledCountExpired = 0;
      let nextScheduledDate = null;
      let nextScheduledStops = 0;
      try {
        const sq = collection(db, "users", uid, "scheduledRoutes");
        const sSnap = await getDocs(sq);
        const now = new Date();
        
        let foundFirst = false;
        
        // Colocar tudo em um array para podermos ordenar no Javascript sem depender do index no Firebase
        let allSchedules = [];
        sSnap.forEach(snap => {
          const d = snap.data();
          if (d.status === 'scheduled') {
            allSchedules.push(d);
          }
        });

        // Ordena por data (ascendente)
        allSchedules.sort((a, b) => {
          const tA = a.scheduledDate && a.scheduledDate.toDate ? a.scheduledDate.toDate().getTime() : 0;
          const tB = b.scheduledDate && b.scheduledDate.toDate ? b.scheduledDate.toDate().getTime() : 0;
          return tA - tB;
        });

        for (const d of allSchedules) {
          const sDate = d.scheduledDate && d.scheduledDate.toDate ? d.scheduledDate.toDate() : null;
          if (!foundFirst && sDate) {
            nextScheduledDate = sDate;
            nextScheduledStops = d.stopsCount || (d.points ? d.points.length : 0);
            foundFirst = true;
          }
          if (sDate && now > sDate) {
            scheduledCountExpired++; // Passou da hora e não enviou
          } else {
            scheduledCountScheduled++; // Agendado (futuro)
          }
        }
      } catch(e) { console.warn("Erro rotas agendadas:", e); }

      // Status da rota manual (Status Principal do Card)
      let manualClass = 'idle';
      let manualText = 'Sem rota manual';
      let manualIcon = '⏹';
      let manualBorder = '#95a5a6';

      if (lastRouteInfo) {
        if (lastRouteInfo.status === 'Pendente') { manualClass = 'pending'; manualText = 'Pendente'; manualBorder = '#e67e22'; manualIcon = '▶️'; }
        if (lastRouteInfo.status === 'Em Andamento') { manualClass = 'active'; manualText = 'Rodando'; manualBorder = '#3498db'; manualIcon = '🚚'; }
        if (lastRouteInfo.status === 'Finalizada') { manualClass = 'completed'; manualText = 'Concluída'; manualBorder = '#27ae60'; manualIcon = '✅'; }
      }

      // Status PRÓPRIO dos agendamentos
      let schedClass = 'idle';
      let schedText = 'Sem agendamento';
      let schedIcon = '⏹';
      let schedColor = '#e74c3c'; // Vermelho (Sem agendamento)

      if (scheduledCountExpired > 0) {
        schedClass = 'expired';
        schedText = 'Atrasado';
        schedIcon = '⚠️';
        schedColor = '#e74c3c'; // Vermelho
      } else if (scheduledCountScheduled > 0) {
        const now = new Date();
        const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        if (nextScheduledDate && nextScheduledDate >= tomorrowStart) {
          // Agendado para amanhã / outro dia
          schedClass = 'sent'; // Usamos a class do verde
          schedIcon = '📅';
          schedColor = '#27ae60'; // Verde
          schedText = `Rota agendada`;
        } else if (nextScheduledDate) {
          // Agendado para hoje
          schedClass = 'pending';
          schedIcon = '⏳';
          schedColor = '#f1c40f'; // Amarelo
          schedText = `Agendamento pendente`;
        }
      }

      // Montar header: paradas + badges menores
      let badgesHtml = '';
      if (scheduledCountScheduled > 0) badgesHtml += `<span class="fdc-count-badge" style="background:#f1c40f; color:#000;">⏳ ${scheduledCountScheduled}</span>`;
      if (scheduledCountExpired > 0) badgesHtml += `<span class="fdc-count-badge" style="background:#e74c3c;">⚠️ ${scheduledCountExpired}</span>`;

      const stopsCount = nextScheduledStops;
      const routeDetailHtml = `
        <div class="fdc-route-detail">
          <div class="fdc-rd-item"><span class="fdc-rd-val">${stopsCount}</span><span class="fdc-rd-label">Paradas (AGENDADA)</span></div>
          ${badgesHtml ? `<div class="fdc-rd-divider"></div><div class="fdc-rd-badges">${badgesHtml}</div>` : ''}
        </div>
      `;

      const card = document.createElement('div');
      card.className = 'fleet-driver-card';
      card.style.borderTop = `3px solid ${manualBorder}`;
      card.onclick = () => window.fpOpenDriverDetail(uid, displayName, email);
      card.innerHTML = `
        ${routeDetailHtml}
        <div class="fdc-content">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
            <div class="fdc-avatar">${initial}</div>
            <div style="flex:1; min-width:0;">
              <h4 class="fdc-name">${escapeHTML(displayName)}</h4>
              <p class="fdc-email">${escapeHTML(email)}</p>
            </div>
          </div>
          <div class="fdc-footer" style="flex-direction: column; align-items: stretch; gap: 8px;">
            <div style="display: flex; justify-content: space-between; gap: 4px;">
              <div class="fdc-status-pill ${manualClass}" style="flex:1; justify-content:center;">
                <span>${manualIcon}</span>
                <span>${manualText}</span>
              </div>
              <div class="fdc-status-pill" style="flex:1; justify-content:center; background-color:${schedColor}20; color:${schedColor}; border:1px solid ${schedColor}40;">
                <span>${schedIcon}</span>
                <span style="font-size:9px;">${schedText}</span>
              </div>
            </div>
          </div>
        </div>
      `;
      grid.appendChild(card);
    }

    if (driverCount === 0) {
      grid.innerHTML = `
        <div style="text-align:center; width:100%; padding:40px 20px;">
          <div style="font-size:36px; margin-bottom:12px;">🚗</div>
          <div style="font-size:14px; font-weight:700; color:var(--pr-text); margin-bottom:4px;">Nenhum motorista ainda</div>
          <div style="font-size:11px; color:var(--pr-text-muted);">Convide motoristas pelo painel "Minha Frota"</div>
        </div>
      `;
    }
  } catch(e) {
    grid.innerHTML = `<p style="text-align:center; width:100%; color:var(--pr-text-muted); font-size:12px;">Erro ao carregar: ${e.message}</p>`;
  }
}

// ══════════════════════════════════════════════════════════
// ROTAS FUTURAS — Detail View & Scheduling
// ══════════════════════════════════════════════════════════

window._fpCurrentDriverUid = '';
window._fpCurrentDriverName = '';
window._fpSchedulePoints = [];
window._fpScheduledRoutesUnsub = null;

// Abrir detalhe de um motorista
window.fpOpenDriverDetail = function(uid, name, email) {
  window._fpCurrentDriverUid = uid;
  window._fpCurrentDriverName = name;

  document.getElementById('fpDriversView').style.display = 'none';
  const detail = document.getElementById('fpDriverDetail');
  detail.style.display = 'flex';

  document.getElementById('fpDetailName').textContent = '📋 ' + escapeHTML(name);
  document.getElementById('fpDetailEmail').textContent = email;

  // Carregar rotas agendadas em tempo real
  fpLoadScheduledRoutes(uid);
};

// Voltar para lista de motoristas
window.fpBackToDrivers = function() {
  if (window._fpScheduledRoutesUnsub) {
    window._fpScheduledRoutesUnsub();
    window._fpScheduledRoutesUnsub = null;
  }
  document.getElementById('fpDriverDetail').style.display = 'none';
  document.getElementById('fpDriversView').style.display = '';
  renderFleetDriverCards(); // Atualizar contadores
};

// Carregar rotas agendadas do Firestore (tempo real)
function fpLoadScheduledRoutes(driverUid) {
  if (window._fpScheduledRoutesUnsub) {
    window._fpScheduledRoutesUnsub();
  }

  const q = query(
    collection(db, "users", driverUid, "scheduledRoutes"),
    orderBy("scheduledDate", "asc")
  );

  window._fpScheduledRoutesUnsub = onSnapshot(q, (snapshot) => {
    const list = document.getElementById('fpScheduledList');
    if (!list) return;
    list.innerHTML = '';

    if (snapshot.empty) {
      list.innerHTML = `
        <div style="padding:30px 20px; text-align:center;">
          <div style="font-size:36px; margin-bottom:10px; opacity:0.4;">📭</div>
          <div style="font-size:12px; font-weight:600; color:var(--pr-text-muted);">Nenhuma rota agendada</div>
          <div style="font-size:10px; color:var(--pr-text-muted); margin-top:4px;">Clique em "Agendar Nova Rota" para começar</div>
        </div>
      `;
      return;
    }

    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const schedId = docSnap.id;
      const status = data.status || 'scheduled';

      let schedDate = 'Data não definida';
      let schedTime = '';
      if (data.scheduledDate && data.scheduledDate.toDate) {
        const d = data.scheduledDate.toDate();
        schedDate = d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
        schedTime = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      }

      // Construir lista de locais
      const stopCount = (data.points || []).length;
      let stopPreview = '';
      if (data.points && data.points.length > 0) {
        const first = data.points[0];
        const last = data.points[data.points.length - 1];
        stopPreview = data.points.length === 1
          ? escapeHTML(first.name || 'Local')
          : `${escapeHTML(first.name || 'Início')} → ${escapeHTML(last.name || 'Destino')}`;
      }

      // Cor da borda por status
      let borderColor = '#3498db'; // scheduled = azul
      let badgeText = 'Agendada';
      let badgeClass = 'scheduled';
      if (status === 'sent') {
        borderColor = '#27ae60'; // verde
        badgeText = 'Enviada';
        badgeClass = 'sent';
      } else if (status === 'expired') {
        borderColor = '#e74c3c'; // vermelho
        badgeText = 'Expirada';
        badgeClass = 'expired';
      }

      const card = document.createElement('div');
      card.className = 'fp-sched-card';
      card.style.borderLeftColor = borderColor;
      card.onclick = () => window.fpOpenEditSchedule(schedId, driverUid);

      card.innerHTML = `
        <div class="sched-header">
          <div class="sched-date">
            <span>📅</span>
            <span>${schedDate}</span>
            <span style="color:var(--pr-blue-dark); font-weight:800;">⏰ ${schedTime || '—'}</span>
          </div>
          <span class="sched-badge ${badgeClass}">${badgeText}</span>
        </div>
        ${stopPreview ? `<div class="sched-stops">📍 ${stopPreview}</div>` : ''}
        ${data.note ? `<div class="sched-note">💬 ${escapeHTML(data.note)}</div>` : ''}
        <div class="sched-actions">
          <span style="font-size:10px; color:var(--pr-text-muted); display:flex; align-items:center; gap:4px;">
            📍 ${stopCount} parada${stopCount !== 1 ? 's' : ''}
            ${status === 'scheduled' ? ' · Toque para editar' : ' · Toque para detalhes'}
          </span>
          <div style="display:flex; gap:4px;">
            ${status === 'scheduled' ? `
              <button onclick="event.stopPropagation(); window.fpSendScheduledNow('${schedId}')" style="background:#27ae60; color:#fff; border:none; padding:5px 10px; border-radius:6px; font-size:10px; font-weight:600; cursor:pointer; font-family:var(--font-main);">📨 Enviar</button>
            ` : ''}
            <button onclick="event.stopPropagation(); window.fpDeleteScheduled('${schedId}')" style="background:var(--pr-bg); color:var(--pr-text-muted); border:1px solid var(--pr-border); padding:5px 8px; border-radius:6px; font-size:10px; cursor:pointer; font-family:var(--font-main);">🗑</button>
          </div>
        </div>
      `;
      list.appendChild(card);
    });
  }, (error) => {
    console.warn("Erro ao carregar rotas agendadas:", error);
  });
}

// Abrir modal de agendamento
window.fpOpenScheduleModal = function() {
  window._fpSchedulePoints = [];
  document.getElementById('schedDriverName').textContent = window._fpCurrentDriverName;
  document.getElementById('schedNote').value = '';
  document.getElementById('schedLocSearch').value = '';

  // Definir data mínima como hoje
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const dateInput = document.getElementById('schedDate');
  dateInput.min = todayStr;
  dateInput.value = todayStr;
  document.getElementById('schedTime').value = '08:00';

  fpRenderScheduleSequence();
  fpRenderScheduleLocations();
  document.getElementById('scheduleRouteModal').classList.add('active');
};

// Fechar modal de agendamento
window.fpCloseScheduleModal = function() {
  document.getElementById('scheduleRouteModal').classList.remove('active');
};

// Renderizar sequência de pontos no modal de agendamento
function fpRenderScheduleSequence() {
  const container = document.getElementById('schedRouteSequence');
  if (window._fpSchedulePoints.length === 0) {
    container.innerHTML = '<div style="font-size:10px; color:var(--pr-text-muted); text-align:center; padding:8px;">Nenhum ponto adicionado. Selecione abaixo.</div>';
    return;
  }
  container.innerHTML = '';
  window._fpSchedulePoints.forEach((loc, i) => {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex; align-items:center; background:var(--pr-surface); border:0.5px solid var(--pr-border); padding:5px 8px; border-radius:6px; gap:8px;';

    const upBtn = i > 0
      ? `<button class="ia-btn" style="width:22px; height:22px; font-size:13px; font-weight:bold; color:var(--pr-text-muted);" onclick="window.fpMoveSchedPoint(${i}, -1)" title="Subir">↑</button>`
      : '<div style="width:22px;"></div>';
    const downBtn = i < window._fpSchedulePoints.length - 1
      ? `<button class="ia-btn" style="width:22px; height:22px; font-size:13px; font-weight:bold; color:var(--pr-text-muted);" onclick="window.fpMoveSchedPoint(${i}, 1)" title="Descer">↓</button>`
      : '<div style="width:22px;"></div>';

    item.innerHTML = `
      <div style="background:var(--pr-blue-dark); color:#fff; font-size:9px; font-weight:700; width:18px; height:18px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0;">${i + 1}</div>
      <div style="flex:1; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--pr-text); font-weight:600;">${escapeHTML(loc.name || loc.originalInput)}</div>
      <div style="display:flex; gap:2px; align-items:center;">
        ${upBtn}
        ${downBtn}
        <button class="ia-btn" style="width:20px; height:20px; font-size:11px; color:#e06666;" onclick="window.fpRemoveSchedPoint(${i})" title="Remover">✕</button>
      </div>
    `;
    container.appendChild(item);
  });
}

// Renderizar locais disponíveis no modal de agendamento
function fpRenderScheduleLocations() {
  const container = document.getElementById('schedAvailableList');
  const term = (document.getElementById('schedLocSearch').value || '').toLowerCase();
  container.innerHTML = '';

  const filtered = allLocations.filter(loc =>
    (loc.name || '').toLowerCase().includes(term) ||
    (loc.originalInput || '').toLowerCase().includes(term)
  );

  filtered.forEach(loc => {
    // Esconder se já estiver selecionado
    if (window._fpSchedulePoints.find(p => p.id === loc.id)) return;

    const item = document.createElement('div');
    item.className = 'loc-item';
    item.style.cssText = 'margin-bottom:4px; padding:6px 10px;';
    item.innerHTML = `
      <div class="loc-dot dot-b" style="cursor:pointer;" onclick="window.fpAddSchedPoint('${loc.id}')">＋</div>
      <div class="loc-info" style="cursor:pointer;" onclick="window.fpAddSchedPoint('${loc.id}')">
        <div class="loc-name">${escapeHTML(loc.name) || 'Endereço'}</div>
        <div class="loc-addr" style="font-size:9px;">Clique para adicionar</div>
      </div>
    `;
    container.appendChild(item);
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:10px; font-size:11px; color:var(--pr-text-muted); text-align:center;">Nenhum local encontrado.</div>';
  }
}

window.fpFilterScheduleLocations = function() {
  fpRenderScheduleLocations();
};

window.fpAddSchedPoint = function(id) {
  const loc = allLocations.find(l => l.id === id);
  if (loc) {
    window._fpSchedulePoints.push(loc);
    document.getElementById('schedLocSearch').value = '';
    fpRenderScheduleSequence();
    fpRenderScheduleLocations();
  }
};

window.fpRemoveSchedPoint = function(index) {
  window._fpSchedulePoints.splice(index, 1);
  fpRenderScheduleSequence();
  fpRenderScheduleLocations();
};

window.fpMoveSchedPoint = function(index, direction) {
  if (direction === -1 && index > 0) {
    const temp = window._fpSchedulePoints[index];
    window._fpSchedulePoints[index] = window._fpSchedulePoints[index - 1];
    window._fpSchedulePoints[index - 1] = temp;
  } else if (direction === 1 && index < window._fpSchedulePoints.length - 1) {
    const temp = window._fpSchedulePoints[index];
    window._fpSchedulePoints[index] = window._fpSchedulePoints[index + 1];
    window._fpSchedulePoints[index + 1] = temp;
  }
  fpRenderScheduleSequence();
};

// Salvar rota agendada no Firestore
window.fpSaveScheduledRoute = async function() {
  const driverUid = window._fpCurrentDriverUid;
  if (!driverUid) return alert("Nenhum motorista selecionado.");

  const dateVal = document.getElementById('schedDate').value;
  const timeVal = document.getElementById('schedTime').value;
  const note = document.getElementById('schedNote').value.trim();

  if (!dateVal) return alert("Selecione uma data para o envio.");
  if (window._fpSchedulePoints.length < 1) return alert("Adicione pelo menos 1 ponto à rota.");

  const btn = document.getElementById('schedSaveBtn');
  btn.textContent = '⏳ Salvando...';
  btn.style.pointerEvents = 'none';
  btn.style.opacity = '0.7';

  try {
    // Montar timestamp do agendamento
    const [year, month, day] = dateVal.split('-').map(Number);
    const [hour, minute] = timeVal.split(':').map(Number);
    const scheduledDate = new Date(year, month - 1, day, hour, minute);

    // Montar link do Google Maps
    const getDeepFormat = (loc) => (loc.lat && loc.lng) ? `${loc.lat},${loc.lng}` : encodeURIComponent(loc.name || loc.originalInput);
    const lastP = window._fpSchedulePoints[window._fpSchedulePoints.length - 1];
    let mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${getDeepFormat(lastP)}&travelmode=driving`;
    if (window._fpSchedulePoints.length > 1) {
      const wpUrls = window._fpSchedulePoints.slice(0, -1).map(getDeepFormat);
      mapsUrl += `&waypoints=${wpUrls.join('%7C')}`;
    }

    // Salvar na subcollection do motorista
    await addDoc(collection(db, "users", driverUid, "scheduledRoutes"), {
      points: window._fpSchedulePoints.map(p => ({ name: p.name, input: p.originalInput, lat: p.lat || null, lng: p.lng || null })),
      stopsCount: window._fpSchedulePoints.length,
      mapsUrl: mapsUrl,
      note: note,
      status: "scheduled",
      scheduledDate: scheduledDate,
      createdAt: serverTimestamp(),
      createdBy: currentUser.uid,
      createdByName: currentUser.displayName || currentUser.email || 'Admin'
    });

    btn.textContent = '✅ Agendada!';
    btn.style.background = '#27ae60';
    setTimeout(() => {
      btn.textContent = '📅 Agendar Rota';
      btn.style.pointerEvents = 'auto';
      btn.style.opacity = '1';
      btn.style.background = '#27ae60';
      window.fpCloseScheduleModal();
    }, 1200);

  } catch(e) {
    console.error("Erro ao agendar rota:", e);
    alert("Erro ao agendar rota: " + e.message);
    btn.textContent = '📅 Agendar Rota';
    btn.style.pointerEvents = 'auto';
    btn.style.opacity = '1';
  }
};

// Enviar rota agendada imediatamente (mover para history)
window.fpSendScheduledNow = async function(schedId) {
  const driverUid = window._fpCurrentDriverUid;
  if (!driverUid) return;

  if (!confirm("Deseja enviar essa rota agora para o motorista?")) return;

  try {
    const schedRef = doc(db, "users", driverUid, "scheduledRoutes", schedId);
    const schedSnap = await getDoc(schedRef);
    if (!schedSnap.exists() || schedSnap.data().status !== "scheduled") return alert("Rota agendada já enviada ou não encontrada.");

    const data = schedSnap.data();

    // Marcar como enviada primeiro para evitar duplicatas
    await updateDoc(schedRef, { status: "sent", sentAt: serverTimestamp() });

    // Criar a rota no history do motorista (mesma lógica do generateManualRoute)
    const routeData = {
      points: data.points || [],
      distance: "—",
      time: "—",
      stopsCount: data.stopsCount || 0,
      polyline: "",
      mapsUrl: data.mapsUrl || "",
      status: "Pendente",
      createdAt: serverTimestamp(),
      assignedBy: currentUser.uid,
      assignedByName: currentUser.displayName || currentUser.email || 'Admin'
    };

    if (data.note) routeData.note = data.note;


    const newRouteRef = await addDoc(collection(db, "users", driverUid, "history"), routeData);
    
    // Tentar calcular detalhes e trajeto em BACKGROUND via OSRM
    window.calculateOSRMBackground(newRouteRef, routeData.points);

    alert("✅ Rota enviada com sucesso para " + window._fpCurrentDriverName + "!");
  } catch(e) {
    console.error("Erro ao enviar rota:", e);
    alert("Erro ao enviar: " + e.message);
  }
};

// ══════════════════════════════════════════════════════════
// SISTEMA DE DESPACHO AUTOMATICO DE ROTAS AGENDADAS
// 3 camadas: onSnapshot + setTimeout preciso + visibilitychange
// ══════════════════════════════════════════════════════════

// IDs ja despachados nesta sessao (anti-duplicata)
window._dispatchedScheduleIds = new Set();
// Timers ativos de setTimeout (para cancelar se necessario)
window._scheduledTimers = {};
// Unsubscribers dos onSnapshot listeners
window._scheduleListenerUnsubs = [];

// Funcao principal que inicializa tudo
window.startScheduledRouteDispatcher = function() {
  if (!currentUser) return;

  // Limpar estado anterior
  if (window._dispatchPollInterval) clearInterval(window._dispatchPollInterval);
  window._scheduleListenerUnsubs.forEach(unsub => { try { unsub(); } catch(e) {} });
  window._scheduleListenerUnsubs = [];
  Object.values(window._scheduledTimers).forEach(t => clearTimeout(t));
  window._scheduledTimers = {};

  console.log("[Scheduler] Iniciando sistema de despacho automatico...");

  // Funcao que despacha UMA rota especifica
  const dispatchSingleRoute = async (driverUid, schedDocRef, schedData, schedId) => {
    // Anti-duplicata: se ja foi despachada nesta sessao, ignorar
    if (window._dispatchedScheduleIds.has(schedId)) return;
    window._dispatchedScheduleIds.add(schedId);

    try {
      // Verificar se ainda esta com status "scheduled" (outra aba pode ter despachado)
      const freshSnap = await getDoc(schedDocRef);
      if (!freshSnap.exists() || freshSnap.data().status !== "scheduled") {
        console.log(`[Scheduler] Rota ${schedId} ja foi processada por outra sessao.`);
        return;
      }

      // Marcar como enviada ANTES de criar no history (evita duplicatas)
      await updateDoc(schedDocRef, { status: "sent", sentAt: serverTimestamp() });

      // Criar a rota no history do motorista
      const routeData = {
        points: schedData.points || [],
        distance: "\u2014",
        time: "\u2014",
        stopsCount: schedData.stopsCount || 0,
        polyline: "",
        mapsUrl: schedData.mapsUrl || "",
        status: "Pendente",
        createdAt: serverTimestamp(),
        assignedBy: currentUser.uid,
        assignedByName: currentUser.displayName || currentUser.email || 'Admin'
      };
      if (schedData.note) routeData.note = schedData.note;

      const newRouteRef = await addDoc(collection(db, "users", driverUid, "history"), routeData);

      // Calcular trajeto OSRM em background
      window.calculateOSRMBackground(newRouteRef, routeData.points);

      console.log(`[Scheduler] \u2705 Rota ${schedId} despachada para ${driverUid}`);
    } catch(e) {
      // Se falhou, remover do set para tentar novamente no proximo ciclo
      window._dispatchedScheduleIds.delete(schedId);
      console.warn(`[Scheduler] Erro ao despachar rota ${schedId}:`, e);
    }
  };

  // Funcao que agenda um setTimeout preciso para uma rota
  const scheduleTimerForRoute = (driverUid, schedDocRef, schedData, schedId) => {
    if (window._dispatchedScheduleIds.has(schedId)) return;
    if (window._scheduledTimers[schedId]) clearTimeout(window._scheduledTimers[schedId]);

    const scheduledDate = schedData.scheduledDate && schedData.scheduledDate.toDate
      ? schedData.scheduledDate.toDate()
      : (schedData.scheduledDate instanceof Date ? schedData.scheduledDate : null);

    if (!scheduledDate) return;

    const msUntil = scheduledDate.getTime() - Date.now();

    if (msUntil <= 0) {
      // Ja passou da hora — despachar imediatamente
      dispatchSingleRoute(driverUid, schedDocRef, schedData, schedId);
    } else if (msUntil <= 24 * 60 * 60 * 1000) {
      // Nas proximas 24h — criar timer preciso
      console.log(`[Scheduler] Timer criado para rota ${schedId}: disparo em ${Math.round(msUntil / 1000)}s`);
      window._scheduledTimers[schedId] = setTimeout(() => {
        dispatchSingleRoute(driverUid, schedDocRef, schedData, schedId);
      }, msUntil);
    }
    // Se for > 24h, o poll de 60s vai pegar quando estiver mais perto
  };

  // ── CAMADA 1: onSnapshot em tempo real ──
  // Escuta mudancas na colecao scheduledRoutes de cada motorista
  const setupListenerForDriver = (driverUid) => {
    const q = query(
      collection(db, "users", driverUid, "scheduledRoutes"),
      where("status", "==", "scheduled")
    );

    const unsub = onSnapshot(q, (snapshot) => {
      // Rastrear IDs atuais nesta snapshot para limpar timers de rotas removidas/alteradas
      const currentIds = new Set();
      
      snapshot.docChanges().forEach((change) => {
        const docSnap = change.doc;
        const schedId = docSnap.id;
        
        if (change.type === "removed" || (change.type === "modified" && docSnap.data().status !== "scheduled")) {
          if (window._scheduledTimers[schedId]) {
            clearTimeout(window._scheduledTimers[schedId]);
            delete window._scheduledTimers[schedId];
          }
        } else {
          // Added ou Modified
          const data = docSnap.data();
          const schedDocRef = docSnap.ref;
          scheduleTimerForRoute(driverUid, schedDocRef, data, schedId);
        }
      });
    }, (err) => {
      console.warn(`[Scheduler] Erro no listener de ${driverUid}:`, err);
    });

    window._scheduleListenerUnsubs.push(unsub);
  };

  // Configurar listeners baseado no papel do usuario
  if (window.userRole === 'admin') {
    // Admin: escutar rotas de todos os motoristas vinculados
    const driversQ = query(collection(db, "users"), where("adminId", "==", window.companyId || currentUser.uid));
    getDocs(driversQ).then(driversSnap => {
      driversSnap.forEach(driverDoc => {
        if (driverDoc.data().role === 'driver') {
          setupListenerForDriver(driverDoc.id);
        }
      });
      // Tambem escutar as proprias rotas do admin (caso tenha)
      setupListenerForDriver(currentUser.uid);
      console.log(`[Scheduler] Listeners ativos para ${driversSnap.size} motorista(s)`);
    }).catch(e => console.warn("[Scheduler] Erro ao buscar motoristas:", e));
  } else {
    // Driver: escutar apenas suas proprias rotas
    setupListenerForDriver(currentUser.uid);
  }

  // ── CAMADA 2: Poll de seguranca a cada 60s ──
  // Pega rotas que o onSnapshot pode ter perdido (ex: adicionadas offline)
  window._dispatchPollInterval = setInterval(async () => {
    try {
      await window.checkAndDispatchScheduledRoutes();
    } catch(e) { /* silencioso */ }
  }, 60000);

  // Executar checagem imediata
  setTimeout(() => window.checkAndDispatchScheduledRoutes(), 2000);

  // ── CAMADA 3: visibilitychange — re-verificar quando a aba volta ao foco ──
  if (!window._visibilitySchedulerBound) {
    window._visibilitySchedulerBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && currentUser) {
        console.log("[Scheduler] Aba reativada — re-verificando rotas agendadas...");
        window.checkAndDispatchScheduledRoutes();
      }
    });
  }
};

// ── Funcao de fallback/poll ──
window.checkAndDispatchScheduledRoutes = async function() {
  if (!currentUser) return;
  const now = new Date();

  const dispatchForDriver = async (driverUid) => {
    try {
      // ✅ Apenas filtro por status (index simples, sem index composto)
      const sq = query(
        collection(db, "users", driverUid, "scheduledRoutes"),
        where("status", "==", "scheduled")
      );
      const sSnap = await getDocs(sq);

      for (const schedSnap of sSnap.docs) {
        const data = schedSnap.data();

        // Converter Timestamp do Firestore para Date
        const scheduledDate = data.scheduledDate && data.scheduledDate.toDate
          ? data.scheduledDate.toDate()
          : (data.scheduledDate instanceof Date ? data.scheduledDate : null);

        // ✅ Filtrar por data em JavaScript — sem necessidade de índice composto
        if (!scheduledDate || scheduledDate > now) continue;

        const schedId = schedSnap.id;
        if (window._dispatchedScheduleIds.has(schedId)) continue;
        window._dispatchedScheduleIds.add(schedId);

        // Verificar novamente o status (anti-concorrencia entre abas)
        const freshSnap = await getDoc(schedSnap.ref);
        if (!freshSnap.exists() || freshSnap.data().status !== "scheduled") continue;

        await updateDoc(schedSnap.ref, { status: "sent", sentAt: serverTimestamp() });

        const routeData = {
          points: data.points || [],
          distance: "\u2014",
          time: "\u2014",
          stopsCount: data.stopsCount || 0,
          polyline: "",
          mapsUrl: data.mapsUrl || "",
          status: "Pendente",
          createdAt: serverTimestamp(),
          assignedBy: currentUser.uid,
          assignedByName: currentUser.displayName || currentUser.email || 'Admin'
        };
        if (data.note) routeData.note = data.note;

        const newRouteRef = await addDoc(collection(db, "users", driverUid, "history"), routeData);
        window.calculateOSRMBackground(newRouteRef, routeData.points);
        console.log(`[Scheduler] ✅ Rota ${schedId} despachada para ${driverUid}`);
      }
    } catch(e) {
      console.warn("[Scheduler] Erro ao checar scheduledRoutes de", driverUid, ":", e);
    }
  };

  if (window.userRole === 'driver') {
    await dispatchForDriver(currentUser.uid);
  } else if (window.userRole === 'admin') {
    try {
      const q = query(collection(db, "users"), where("adminId", "==", window.companyId || currentUser.uid));
      const driversSnap = await getDocs(q);
      const promises = [];
      driversSnap.forEach(docSnap => {
        if (docSnap.data().role === 'driver') {
          promises.push(dispatchForDriver(docSnap.id));
        }
      });
      promises.push(dispatchForDriver(currentUser.uid));
      await Promise.all(promises);
    } catch(e) {
      console.warn("[Scheduler] Erro auto dispatch:", e);
    }
  }
};

// Excluir rota agendada
window.fpDeleteScheduled = async function(schedId) {
  const driverUid = window._fpCurrentDriverUid;
  if (!driverUid) return;

  if (!confirm("Deseja excluir esta rota agendada?")) return;

  try {
    await deleteDoc(doc(db, "users", driverUid, "scheduledRoutes", schedId));
  } catch(e) {
    alert("Erro ao excluir: " + e.message);
  }
};

// ══════════════════════════════════════════════════════════
// EDIT / VIEW SCHEDULED ROUTE MODAL
// ══════════════════════════════════════════════════════════

window._editSchedId = '';
window._editSchedDriverUid = '';
window._editSchedPoints = [];
window._editSchedStatus = 'scheduled';

window.fpOpenEditSchedule = async function(schedId, driverUid) {
  window._editSchedId = schedId;
  window._editSchedDriverUid = driverUid || window._fpCurrentDriverUid;
  
  try {
    const schedRef = doc(db, "users", window._editSchedDriverUid, "scheduledRoutes", schedId);
    const schedSnap = await getDoc(schedRef);
    if (!schedSnap.exists()) return alert("Agendamento não encontrado.");

    const data = schedSnap.data();
    window._editSchedPoints = (data.points || []).map((p, i) => ({
      id: `sched_${i}_${Date.now()}`,
      name: p.name || p.input || 'Local',
      originalInput: p.input || p.name || '',
      lat: p.lat || null,
      lng: p.lng || null
    }));
    window._editSchedStatus = data.status || 'scheduled';

    // Preencher informações do modal
    let schedDate = '—';
    let schedTime = '—';
    if (data.scheduledDate && data.scheduledDate.toDate) {
      const d = data.scheduledDate.toDate();
      schedDate = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
      schedTime = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    document.getElementById('editSchedTitle').textContent = window._editSchedStatus === 'scheduled' ? '✏️ Editar Agendamento' : '📋 Detalhes do Agendamento';
    document.getElementById('editSchedDate').textContent = `📅 ${schedDate} · ⏰ ${schedTime}`;
    document.getElementById('editSchedNote').textContent = data.note ? `💬 ${data.note}` : '';
    
    // Mostrar/ocultar botões de edição
    const saveBtn = document.getElementById('editSchedSaveBtn');
    const addSection = document.getElementById('editSchedAddSection');
    if (window._editSchedStatus === 'scheduled') {
      saveBtn.style.display = '';
      addSection.style.display = '';
    } else {
      saveBtn.style.display = 'none';
      addSection.style.display = 'none';
    }

    fpRenderEditSchedStops();
    document.getElementById('editScheduledRouteModal').classList.add('active');
  } catch(e) {
    console.error("Erro ao abrir edição:", e);
    alert("Erro ao abrir agendamento: " + e.message);
  }
};

window.fpCloseEditSchedule = function() {
  document.getElementById('editScheduledRouteModal').classList.remove('active');
};

function fpRenderEditSchedStops() {
  const container = document.getElementById('editSchedStopsList');
  container.innerHTML = '';
  const isEditable = window._editSchedStatus === 'scheduled';

  if (window._editSchedPoints.length === 0) {
    container.innerHTML = '<div style="font-size:11px; color:var(--pr-text-muted); text-align:center; padding:16px;">Nenhuma parada adicionada.</div>';
    return;
  }

  window._editSchedPoints.forEach((p, i) => {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex; align-items:center; background:var(--pr-surface); border:1px solid var(--pr-border); padding:8px 10px; border-radius:8px; gap:8px; transition: all 0.15s;';

    const orderBtns = isEditable ? `
      <div style="display:flex; flex-direction:column; gap:2px;">
        ${i > 0 ? `<button class="ia-btn" style="width:20px; height:16px; font-size:11px; color:var(--pr-text-muted);" onclick="window.fpEditSchedMove(${i}, -1)">↑</button>` : '<div style="height:16px;"></div>'}
        ${i < window._editSchedPoints.length - 1 ? `<button class="ia-btn" style="width:20px; height:16px; font-size:11px; color:var(--pr-text-muted);" onclick="window.fpEditSchedMove(${i}, 1)">↓</button>` : '<div style="height:16px;"></div>'}
      </div>
    ` : '';

    const removeBtn = isEditable ? `<button class="ia-btn" style="width:22px; height:22px; font-size:12px; color:#e74c3c;" onclick="window.fpEditSchedRemove(${i})">✕</button>` : '';

    item.innerHTML = `
      <div style="background:var(--pr-blue-dark); color:#fff; font-size:10px; font-weight:700; width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0;">${i + 1}</div>
      <div style="flex:1; min-width:0;">
        <div style="font-size:12px; font-weight:600; color:var(--pr-text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(p.name)}</div>
        ${p.lat && p.lng ? `<div style="font-size:9px; color:var(--pr-text-muted);">${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</div>` : ''}
      </div>
      ${orderBtns}
      ${removeBtn}
    `;
    container.appendChild(item);
  });
}

window.fpEditSchedMove = function(index, direction) {
  const arr = window._editSchedPoints;
  if (direction === -1 && index > 0) {
    [arr[index], arr[index - 1]] = [arr[index - 1], arr[index]];
  } else if (direction === 1 && index < arr.length - 1) {
    [arr[index], arr[index + 1]] = [arr[index + 1], arr[index]];
  }
  fpRenderEditSchedStops();
};

window.fpEditSchedRemove = function(index) {
  window._editSchedPoints.splice(index, 1);
  fpRenderEditSchedStops();
  fpRenderEditSchedAvailable();
};

function fpRenderEditSchedAvailable() {
  const container = document.getElementById('editSchedAvailList');
  const term = (document.getElementById('editSchedSearch').value || '').toLowerCase();
  container.innerHTML = '';

  const filtered = allLocations.filter(loc =>
    (loc.name || '').toLowerCase().includes(term) ||
    (loc.originalInput || '').toLowerCase().includes(term)
  );

  const selectedIds = new Set(window._editSchedPoints.map(p => p.name));
  
  filtered.forEach(loc => {
    if (selectedIds.has(loc.name)) return;

    const item = document.createElement('div');
    item.className = 'loc-item';
    item.style.cssText = 'margin-bottom:3px; padding:5px 8px; cursor:pointer;';
    item.onclick = () => {
      window._editSchedPoints.push({
        id: loc.id,
        name: loc.name,
        originalInput: loc.originalInput,
        lat: loc.lat || null,
        lng: loc.lng || null
      });
      document.getElementById('editSchedSearch').value = '';
      fpRenderEditSchedStops();
      fpRenderEditSchedAvailable();
    };
    item.innerHTML = `
      <div class="loc-dot dot-b">＋</div>
      <div class="loc-info">
        <div class="loc-name">${escapeHTML(loc.name) || 'Endereço'}</div>
        <div class="loc-addr" style="font-size:9px;">Adicionar parada</div>
      </div>
    `;
    container.appendChild(item);
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:8px; font-size:10px; color:var(--pr-text-muted); text-align:center;">Nenhum local encontrado.</div>';
  }
}

window.fpFilterEditSchedLocations = function() {
  fpRenderEditSchedAvailable();
};

window.fpSaveEditSchedule = async function() {
  if (window._editSchedPoints.length < 1) return alert("Adicione pelo menos 1 parada.");

  const btn = document.getElementById('editSchedSaveBtn');
  btn.textContent = '⏳ Salvando...';
  btn.style.pointerEvents = 'none';

  try {
    const getDeepFormat = (loc) => (loc.lat && loc.lng) ? `${loc.lat},${loc.lng}` : encodeURIComponent(loc.name || loc.originalInput);
    const lastP = window._editSchedPoints[window._editSchedPoints.length - 1];
    let mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${getDeepFormat(lastP)}&travelmode=driving`;
    if (window._editSchedPoints.length > 1) {
      const wpUrls = window._editSchedPoints.slice(0, -1).map(getDeepFormat);
      mapsUrl += `&waypoints=${wpUrls.join('%7C')}`;
    }

    const schedRef = doc(db, "users", window._editSchedDriverUid, "scheduledRoutes", window._editSchedId);
    await updateDoc(schedRef, {
      points: window._editSchedPoints.map(p => ({ name: p.name, input: p.originalInput, lat: p.lat || null, lng: p.lng || null })),
      stopsCount: window._editSchedPoints.length,
      mapsUrl: mapsUrl
    });

    btn.textContent = '✅ Salvo!';
    btn.style.background = '#27ae60';
    setTimeout(() => {
      btn.textContent = '💾 Salvar Alterações';
      btn.style.pointerEvents = 'auto';
      btn.style.background = 'var(--pr-blue-dark)';
      window.fpCloseEditSchedule();
    }, 1000);
  } catch(e) {
    console.error("Erro ao salvar edição:", e);
    alert("Erro ao salvar: " + e.message);
    btn.textContent = '💾 Salvar Alterações';
    btn.style.pointerEvents = 'auto';
  }
};

// ══════════════════════════════════════════════════════════
// FLEET MANAGEMENT — Convidar e listar motoristas
// ══════════════════════════════════════════════════════════

async function cleanupExpiredInvitesAndKeys() {
  if (window.userRole !== 'admin') return;
  
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  try {
    const invitesQ = query(
      collection(db, "invites"),
      where("adminId", "==", window.companyId || currentUser.uid),
      where("usado", "==", false)
    );
    const snap = await getDocs(invitesQ);
    snap.forEach(d => {
      const data = d.data();
      const createdAt = data.criadoEm?.toDate ? data.criadoEm.toDate().getTime() : 0;
      if (createdAt > 0 && (now - createdAt) > dayMs) {
        deleteDoc(d.ref).catch(e => console.log('Erro ao apagar invite', e));
      }
    });
  } catch (e) { console.log('cleanup invites erro', e); }

  try {
    const keysQ = query(
      collection(db, "admin_keys"),
      where("createdBy", "==", window.companyId || currentUser.uid),
      where("usado", "==", false)
    );
    const snap = await getDocs(keysQ);
    snap.forEach(d => {
      const data = d.data();
      const createdAt = data.createdAt?.toDate ? data.createdAt.toDate().getTime() : 0;
      if (createdAt > 0 && (now - createdAt) > dayMs) {
        deleteDoc(d.ref).catch(e => console.log('Erro ao apagar admin key', e));
      }
    });
  } catch (e) { console.log('cleanup admin keys erro', e); }
}

window.openFleetModal = function() {
  document.getElementById('fleetModal').classList.add('active');
  document.getElementById('inviteLinkResult').style.display = 'none';
  cleanupExpiredInvitesAndKeys();
  loadFleetDrivers();
};

window.closeFleetModal = function() {
  document.getElementById('fleetModal').classList.remove('active');
  document.getElementById('inviteLinkResult').style.display = 'none';
  document.getElementById('adminInviteResult').style.display = 'none';
  document.getElementById('sendInviteBtn').textContent = '🔗 Gerar Ficha Motorista';
  document.getElementById('sendInviteBtn').style.pointerEvents = 'auto';
};

window.sendDriverInvite = async function() {
  const sendBtn = document.getElementById('sendInviteBtn');
  
  sendBtn.textContent = "...";
  sendBtn.style.pointerEvents = "none";

  try {
    // Generate unique invite code
    const codigo = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).substr(2, 9));
    
    // Save to invites collection
    await setDoc(doc(db, "invites", codigo), {
      adminId: window.companyId,
      usado: false,
      criadoEm: serverTimestamp()
    });

    // Build invite link
    const baseUrl = window.location.origin + window.location.pathname.replace(/[^\/]*$/, '');
    const inviteLink = `${baseUrl}routes_login.html?convite=${codigo}`;
    
    // Show link to admin
    const linkResult = document.getElementById('inviteLinkResult');
    const linkText = document.getElementById('inviteLinkText');
    linkText.textContent = inviteLink;
    linkResult.style.display = 'block';
    linkResult.style.animation = 'fadeSlideIn 0.3s ease-out';
    
    // Store for copy
    window._lastInviteLink = inviteLink;
    window.copyInviteLink(sendBtn); // Pass the button directly
  } catch(e) {
    alert("Erro ao gerar convite: " + e.message);
    sendBtn.textContent = "🔗 Gerar Link e Copiar";
    sendBtn.style.pointerEvents = "auto";
  }
};

window.copyInviteLink = function(btnOverride) {
  if (window._lastInviteLink) {
    navigator.clipboard.writeText(window._lastInviteLink).then(() => {
      const btn = btnOverride || document.getElementById('sendInviteBtn');
      if (btn) {
        btn.textContent = "✅ Link Copiado!";
        setTimeout(() => {
          btn.textContent = "🔗 Gerar Link e Copiar";
          btn.style.pointerEvents = "auto";
        }, 3000);
      }
    }).catch(() => {
      prompt("Copie o link manualmente:", window._lastInviteLink);
      const btn = btnOverride || document.getElementById('sendInviteBtn');
      if (btn) {
        btn.textContent = "🔗 Gerar Link e Copiar";
        btn.style.pointerEvents = "auto";
      }
    });
  }
};

async function loadFleetDrivers() {
  const list = document.getElementById('fleetDriversList');
  list.innerHTML = '<p style="text-align:center; font-size:12px; color:var(--pr-text-muted);">Buscando motoristas...</p>';

  try {
    const q = query(collection(db, "users"), where("adminId", "==", window.companyId));
    const snapshot = await getDocs(q);
    list.innerHTML = '';

    if (snapshot.empty) {
      list.innerHTML = `
        <div style="padding: 20px; text-align: center;">
          <div style="font-size: 30px; margin-bottom: 8px; opacity: 0.5;">👥</div>
          <div class="text-dark-auto" style="font-size: 12px; font-weight: 600;">Nenhum motorista vinculado</div>
          <div style="font-size: 10px; color: var(--pr-text-muted); margin-top: 4px;">Use o formulário acima para convidar.</div>
        </div>
      `;
      return;
    }

    snapshot.forEach((docSnap) => {
      const u = docSnap.data();
      const uid = docSnap.id;
      const displayName = u.apelido || u.nome || 'Sem nome';
      const initial = displayName.charAt(0).toUpperCase();

      const card = document.createElement('div');
      card.style.cssText = "background: var(--pr-surface); border: 1px solid var(--pr-border); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px;";
      
      card.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
          <div id="fleet_avatar_${uid}" style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, var(--pr-blue-mid), var(--pr-blue-dark)); display: flex; align-items: center; justify-content: center; color: #fff; font-size: 16px; font-weight: 700; flex-shrink: 0;">
            ${initial}
          </div>
          <div style="flex: 1; min-width: 0;">
            <div id="fleet_name_${uid}" class="text-dark-auto" style="font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(displayName)}</div>
            <div style="font-size: 10px; color: var(--pr-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(u.email || '')}</div>
          </div>
          <div style="flex-shrink: 0;">
            <span style="font-size: 9px; background: #27ae60; color: #fff; padding: 3px 10px; border-radius: 10px; font-weight: bold;">Ativo</span>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <label style="font-size:10px; font-weight:700; color:var(--pr-text-muted); white-space:nowrap;">Apelido:</label>
          <input type="text" value="${escapeHTML(u.apelido || '')}" placeholder="Ex: João da Van" 
            style="flex:1; border:1px solid var(--pr-border); border-radius:6px; padding:5px 8px; font-size:11px; background:var(--pr-bg); color:var(--pr-text); outline:none;"
            id="nick_${uid}" data-realname="${escapeHTML(u.nome || 'Sem nome')}" />
          <button onclick="event.stopPropagation(); window.saveDriverNickname('${uid}', this)" 
            style="border:none; background:#1A6BAF; color:#fff; border-radius:6px; padding:5px 12px; font-size:10px; font-weight:700; cursor:pointer; white-space:nowrap;">Salvar</button>
        </div>
      `;
      
      list.appendChild(card);
    });
  } catch(e) {
    list.innerHTML = `<p style="text-align:center; color:red; font-size:12px;">Erro ao carregar: ${e.message}</p>`;
  }
}

window.saveDriverNickname = async function(driverUid, btn) {
  const input = document.getElementById('nick_' + driverUid);
  const nameEl = document.getElementById('fleet_name_' + driverUid);
  const avatarEl = document.getElementById('fleet_avatar_' + driverUid);
  if (!input) return;
  const apelido = input.value.trim();
  const realName = input.dataset.realname;
  
  btn.textContent = '...';
  btn.style.pointerEvents = 'none';
  try {
    const finalDisplay = apelido || realName || 'Sem nome';
    await updateDoc(doc(db, "users", driverUid), { apelido: apelido });
    
    // Instantly update visual state in the DOM
    if (nameEl) nameEl.textContent = finalDisplay;
    if (avatarEl) avatarEl.textContent = finalDisplay.charAt(0).toUpperCase();

    btn.textContent = '✅';
    btn.style.background = '#27ae60';
    setTimeout(() => {
      btn.textContent = 'Salvar';
      btn.style.background = '#1A6BAF';
      btn.style.pointerEvents = 'auto';
    }, 2000);
    // Also refresh the builder driver cards
    applyRoleUI();
  } catch(e) {
    btn.textContent = 'Erro';
    btn.style.background = '#e74c3c';
    setTimeout(() => {
      btn.textContent = 'Salvar';
      btn.style.background = '#1A6BAF';
      btn.style.pointerEvents = 'auto';
    }, 2000);
    console.warn('Erro ao salvar apelido:', e);
  }
};

// PAINEL DA FROTA P/ ADMIN (Frota ao Vivo)
window.openAdminHub = function() {
  document.getElementById('adminHubModal').classList.add('active');
  loadAdminHubData();
};

window.closeAdminHub = function() {
  document.getElementById('adminHubModal').classList.remove('active');
  if (window._adminHubUnsubscribe) {
    window._adminHubUnsubscribe();
    window._adminHubUnsubscribe = null;
  }
};

async function loadAdminHubData() {
  const content = document.getElementById('adminHubContent');
  content.innerHTML = `
    <div style="padding: 20px; text-align: center;">
      <div class="status-pulse blue" style="margin-right: 0; width: 12px; height: 12px;"></div>
      <p style="font-size:12px; color:var(--pr-text-muted); margin-top:10px;">Sincronizando Frota ao Vivo...</p>
      <div style="font-size:9px; color:var(--pr-blue-mid); font-weight:700; margin-top:5px; text-transform:uppercase; letter-spacing:1px; animation: pulse 2s infinite;">● Conexão Ativa</div>
    </div>`;
  
  if (window._adminHubUnsubscribe) {
    window._adminHubUnsubscribe();
  }

  try {
    const usersQ = query(collection(db, "users"), where("adminId", "==", window.companyId));
    
    // Fail-safe para sincronização: se demorar demais, avisar o usuário
    const syncTimeout = setTimeout(() => {
      if (content.querySelector('.status-pulse')) {
        content.innerHTML = `
          <div style="padding: 30px; text-align: center; color: var(--pr-text-muted);">
            <div style="font-size: 24px; margin-bottom: 10px;">📡</div>
            <p style="font-size: 12px;">A conexão está demorando mais que o esperado.</p>
            <button onclick="window.loadAdminHubData()" class="mbtn mbtn-save" style="margin-top:10px; padding: 8px 16px; font-size:11px;">Tentar Reiniciar Conexão</button>
          </div>`;
      }
    }, 10000);

    window._adminHubUnsubscribe = onSnapshot(usersQ, async (snapshot) => {
      clearTimeout(syncTimeout);
      content.innerHTML = '';
      
      if (snapshot.empty) {
        content.innerHTML = `<div style="padding: 40px; text-align: center; opacity: 0.5;">
          <div style="font-size: 40px; margin-bottom: 10px;">👥</div>
          <div class="text-dark-auto" style="font-size: 13px; font-weight: 700;">Nenhum motorista vinculado</div>
          <div style="font-size: 11px; color: var(--pr-text-muted); margin-top: 5px;">Use "Minha Frota" para convidar sua equipe.</div>
        </div>`;
        return;
      }

      // Grid container for premium look
      const grid = document.createElement('div');
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(280px, 1fr))";
      grid.style.gap = "15px";
      content.appendChild(grid);

      for (const userDoc of snapshot.docs) {
        const u = userDoc.data();
        if (u.role === "driver") {
          // Obter a última rota em tempo real
          const hQ = query(collection(db, "users", userDoc.id, "history"), orderBy("createdAt", "desc"), limit(1));
          const hSnap = await getDocs(hQ);
          
          const card = document.createElement('div');
          card.className = 'hub-card';
          
          let displayName = u.apelido || u.nome || u.email || 'Motorista';
          const initial = displayName.charAt(0).toUpperCase();

          if (hSnap.empty) {
            card.innerHTML = `
              <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
                <div style="display: flex; gap: 12px; align-items: center;">
                  <div class="fdc-avatar">${initial}</div>
                  <div>
                    <div class="fdc-name" style="display:flex; align-items:center; gap:5px;">
                      ${escapeHTML(displayName)}
                      <span style="font-size:10px; cursor:pointer; opacity: 0.5;" onclick="renameDriver('${userDoc.id}', '${(displayName).replace(/'/g, "\\'")}')">✏️</span>
                    </div>
                    <div class="fdc-email">${escapeHTML(u.email || "")}</div>
                  </div>
                </div>
              </div>

              <div id="hub-route-${userDoc.id}" style="font-size:11px; color:var(--pr-text-muted); background:var(--pr-bg); padding:8px 10px; border-radius:8px; border:1px solid var(--pr-border);">
                Pendente: Sem histórico de rotas
              </div>

              <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
                <button onclick="window.closeAdminHub(); window.openLiveSpy('${userDoc.id}')" class="mbtn mbtn-save" style="padding:8px; font-size:11px; display:flex; align-items:center; justify-content:center; gap:5px; background:var(--pr-blue-dark);">
                  <span>🛰️</span> Espionar
                </button>
                <button onclick="window.openDriverStats('${userDoc.id}', '${escapeHTML(displayName)}')" class="mbtn mbtn-cancel" style="padding:8px; font-size:11px; display:flex; align-items:center; justify-content:center; gap:5px;">
                  <span>📈</span> Desempenho
                </button>
              </div>
            `;
          } else {
            const r = hSnap.docs[0].data();
            const routeStatus = r.status || "Pendente";
            let stClass = "blue";
            let stBadgeColor = "var(--pr-blue-dark)";
            
            if (routeStatus === "Finalizada" || routeStatus === "Concluída") {
              stClass = "green";
              stBadgeColor = "#27ae60";
            } else if (routeStatus === "Pendente") {
              stClass = "blue";
              stBadgeColor = "#f39c12";
            } else if (routeStatus === "Cancelada") {
              stBadgeColor = "#e74c3c";
            }

            let startedTimeHTML = '';
            if (r.startedAt && r.startedAt.toDate) {
              const dObj = r.startedAt.toDate();
              startedTimeHTML = `<div style="font-size:10px; color:var(--pr-blue-mid); margin-top:2px;">🏎️ Iniciou às ${dObj.toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}</div>`;
            }
            
            const locRef = rtdbRef(rtdb, `locations/${window.companyId}/${userDoc.id}`);
            // Usaremos um listener local para esse card para ser 100% real-time
            // Mas para simplificar neste loop, vamos apenas deixar um placeholder que será preenchido
            
            card.innerHTML = `
              <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
                <div style="display: flex; align-items: center; gap: 12px;">
                  <div class="fdc-avatar">${initial}</div>
                  <div style="flex: 1; min-width: 0;">
                    <div class="text-dark-auto" style="font-weight:800; font-size:14px; display: flex; align-items: center; gap: 6px;">
                      ${escapeHTML(displayName)}
                      <span style="font-size:10px; cursor:pointer; opacity: 0.5;" onclick="renameDriver('${userDoc.id}', '${(displayName).replace(/'/g, "\\'")}')">✏️</span>
                    </div>
                    <div style="font-size:11px; color:var(--pr-text-muted); display: flex; align-items: center;">
                      <span class="status-pulse ${stClass}"></span>
                      ${escapeHTML(routeStatus)}
                    </div>
                  </div>
                </div>
                <span class="hub-status-badge" style="background: ${stBadgeColor}">${escapeHTML(routeStatus)}</span>
              </div>
              
              <div style="background: var(--pr-bg); border-radius: 8px; padding: 10px; margin-top: 4px; border: 1px dashed var(--pr-border);">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div style="font-size:11px; font-weight: 700; color: var(--pr-text);">
                    📍 ${r.stopsCount || 0} Paradas 
                    ${r.distance && r.distance !== "—" ? ` | 🛣️ ${r.distance}km` : ''} 
                    ${r.time && r.time !== "—" ? ` | ⏱️ ${r.time}min` : ''}
                  </div>
                  <div id="hub-nearest-${userDoc.id}" style="font-size:9px; font-weight:700; color:${stBadgeColor};"></div>
                </div>
                ${startedTimeHTML}
              </div>

              <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
                <button onclick="window.closeAdminHub(); window.openLiveSpy('${userDoc.id}')" class="mbtn mbtn-save" style="padding:8px; font-size:11px; display:flex; align-items:center; justify-content:center; gap:5px; background:var(--pr-blue-dark);">
                  <span>🛰️</span> Espionar
                </button>
                <button onclick="window.openDriverStats('${userDoc.id}', '${escapeHTML(displayName)}')" class="mbtn mbtn-cancel" style="padding:8px; font-size:11px; display:flex; align-items:center; justify-content:center; gap:5px;">
                  <span>📈</span> Desempenho
                </button>
              </div>
            `;

            // Vincular listener de localização para o "Próximo"
            if (routeStatus === "Em Rota") {
              onValue(locRef, (lSnap) => {
                const lData = lSnap.val();
                const targetEl = document.getElementById(`hub-nearest-${userDoc.id}`);
                if (targetEl && lData && lData.nearestStop) {
                  targetEl.textContent = `Perto de: ${lData.nearestStop.name}`;
                  targetEl.style.animation = "pulse 2s infinite";
                }
              }, { onlyOnce: true }); // Apenas uma vez para não criar milhares de listeners se o usuário abrir/fechar muito
            }
          }
          grid.appendChild(card);
        }
      }
    });

  } catch(e) {
    console.warn("Erro ao configurar listener do hub", e);
    content.innerHTML = '<p style="text-align:center; color:red; font-size:12px;">Erro ao carregar dados em tempo real.</p>';
  }
}

// Inicia o loop de atualização (a cada 1 segundo)
setInterval(updateCardDate, 1000);
updateCardDate();

// ═══════════════════════════════════════════════════
// QR CODE GENERATOR — Localização via Maps/WhatsApp
// ═══════════════════════════════════════════════════
(function() {
  let qrSrc = 'wa';
  let qrCurrentURL = '';

  const qrCfg = {
    wa: { label: 'Link do WhatsApp', hint: 'Cole o link de localização recebido no WhatsApp', ph: 'https://maps.google.com/?q=-15.79,-47.88' },
    gm: { label: 'Link do Google Maps', hint: 'Clique em Compartilhar no Maps e cole o link aqui', ph: 'https://maps.app.goo.gl/...' }
  };

  function parseCoords(u) {
    let m = u.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (m) return [parseFloat(m[1]), parseFloat(m[2])];
    m = u.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (m) return [parseFloat(m[1]), parseFloat(m[2])];
    return null;
  }

  function validateUrl(u) {
    return u.includes('maps.google.com') || u.includes('maps.app.goo.gl') || u.includes('goo.gl/maps') || u.includes('google.com/maps');
  }

  window.openQrModal = function() {
    document.getElementById('qrCodeModal').classList.add('active');
    // Reset state
    document.getElementById('qr-link-input').value = '';
    document.getElementById('qr-detected').style.display = 'none';
    document.getElementById('qr-error-msg').style.display = 'none';
    document.getElementById('qr-result-section').style.display = 'none';
    document.getElementById('qr-output').innerHTML = '';
    qrCurrentURL = '';
    qrSrc = 'wa';
    document.getElementById('qr-btn-wa').className = 'qr-src-btn qr-wa-active';
    document.getElementById('qr-btn-gm').className = 'qr-src-btn';
    document.getElementById('qr-field-label').textContent = qrCfg.wa.label;
    document.getElementById('qr-field-hint').textContent = qrCfg.wa.hint;
    document.getElementById('qr-link-input').placeholder = qrCfg.wa.ph;
  };

  window.closeQrModal = function() {
    document.getElementById('qrCodeModal').classList.remove('active');
  };

  window.qrSwitchSrc = function(s) {
    qrSrc = s;
    document.getElementById('qr-btn-wa').className = 'qr-src-btn' + (s === 'wa' ? ' qr-wa-active' : '');
    document.getElementById('qr-btn-gm').className = 'qr-src-btn' + (s === 'gm' ? ' qr-gm-active' : '');
    document.getElementById('qr-field-label').textContent = qrCfg[s].label;
    document.getElementById('qr-field-hint').textContent = qrCfg[s].hint;
    document.getElementById('qr-link-input').placeholder = qrCfg[s].ph;
    document.getElementById('qr-link-input').value = '';
    document.getElementById('qr-detected').style.display = 'none';
    document.getElementById('qr-error-msg').style.display = 'none';
    document.getElementById('qr-result-section').style.display = 'none';
    document.getElementById('qr-output').innerHTML = '';
    qrCurrentURL = '';
  };

  window.qrOnInput = function() {
    const v = document.getElementById('qr-link-input').value.trim();
    const c = parseCoords(v);
    const b = document.getElementById('qr-detected');
    if (c) {
      document.getElementById('qr-detected-txt').textContent = `Lat ${c[0].toFixed(5)}  Lng ${c[1].toFixed(5)}`;
      b.style.display = 'flex';
    } else {
      b.style.display = 'none';
    }
  };

  window.qrGenerate = function() {
    const errEl = document.getElementById('qr-error-msg');
    errEl.style.display = 'none';

    const v = document.getElementById('qr-link-input').value.trim();
    if (!v) {
      errEl.textContent = qrSrc === 'wa' ? 'Cole o link do WhatsApp.' : 'Cole o link do Google Maps.';
      errEl.style.display = 'block';
      return;
    }
    if (!v.startsWith('http')) {
      errEl.textContent = 'O link deve começar com https://';
      errEl.style.display = 'block';
      return;
    }
    if (!validateUrl(v)) {
      errEl.textContent = qrSrc === 'wa' ? 'Link não reconhecido. Use o link de localização do WhatsApp.' : 'Link não reconhecido. Use o link de compartilhamento do Google Maps.';
      errEl.style.display = 'block';
      return;
    }

    const c = parseCoords(v);
    const url = c ? `https://www.google.com/maps?q=${c[0]},${c[1]}` : v;
    qrCurrentURL = url;

    const el = document.getElementById('qr-output');
    el.innerHTML = '';
    new QRCode(el, {
      text: url,
      width: 152,
      height: 152,
      colorDark: '#6c5ce7',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });

    document.getElementById('qr-result-url').textContent = url.length > 52 ? url.slice(0, 49) + '...' : url;
    document.getElementById('qr-result-section').style.display = 'flex';
  };

  window.qrCopyLink = function() {
    if (!qrCurrentURL) return;
    navigator.clipboard.writeText(qrCurrentURL).then(() => {
      const b = document.getElementById('qr-copy-btn');
      const original = b.innerHTML;
      b.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#27ae60" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> Copiado!';
      b.style.color = '#27ae60';
      b.style.borderColor = '#27ae60';
      setTimeout(() => {
        b.innerHTML = original;
        b.style.color = '';
        b.style.borderColor = '';
      }, 1800);
    });
  };

  window.qrDownload = function() {
    const c = document.querySelector('#qr-output canvas');
    if (!c) return;
    const a = document.createElement('a');
    a.download = 'qrcode-localizacao.png';
    a.href = c.toDataURL('image/png');
    a.click();
  };
})();

// ═══════════════════════════════════════════════════
// QR CODE SCANNER — Leitor via câmera (Motorista)
// ═══════════════════════════════════════════════════
(function() {
  let scanStream = null;
  let scanAnimId = null;
  let scanDetected = false;
  let scanResultURL = '';

  window.openQrScanModal = function() {
    document.getElementById('qrScanModal').classList.add('active');
    qrScanResetUI();
  };

  window.closeQrScanModal = function() {
    document.getElementById('qrScanModal').classList.remove('active');
    qrScanStopCamera();
  };

  function qrScanStopCamera() {
    if (scanAnimId) { cancelAnimationFrame(scanAnimId); scanAnimId = null; }
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
    const v = document.getElementById('qr-scan-video');
    if (v) { v.srcObject = null; v.style.display = 'none'; }
    const ov = document.getElementById('qr-scan-overlay');
    if (ov) ov.style.display = 'none';
    document.getElementById('qr-scan-idle').style.display = 'flex';
  }

  function qrScanResetUI() {
    scanDetected = false;
    scanResultURL = '';
    document.getElementById('qr-scan-result').style.display = 'none';
    document.getElementById('qr-scan-error').style.display = 'none';
    document.getElementById('qr-scan-url-txt').textContent = '';
    document.getElementById('qr-scan-start-btn').style.display = 'flex';
    document.getElementById('qr-scan-hint').textContent = 'Aponte para o QR Code de localização';
    qrScanStopCamera();
  }

  window.qrScanReset = function() {
    qrScanResetUI();
  };

  window.qrScanStart = async function() {
    const errEl = document.getElementById('qr-scan-error');
    errEl.style.display = 'none';

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      errEl.textContent = 'Câmera não suportada neste dispositivo/navegador.';
      errEl.style.display = 'block';
      return;
    }

    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });

      const video = document.getElementById('qr-scan-video');
      video.srcObject = scanStream;
      video.style.display = 'block';
      document.getElementById('qr-scan-idle').style.display = 'none';
      document.getElementById('qr-scan-overlay').style.display = 'block';
      document.getElementById('qr-scan-start-btn').style.display = 'none';
      document.getElementById('qr-scan-hint').textContent = 'Aponte para o QR Code...';

      video.onloadedmetadata = () => {
        video.play();
        qrScanLoop();
      };
    } catch (e) {
      let msg = 'Erro ao acessar a câmera.';
      if (e.name === 'NotAllowedError') msg = 'Permissão de câmera negada. Autorize nas configurações do navegador.';
      else if (e.name === 'NotFoundError') msg = 'Nenhuma câmera encontrada no dispositivo.';
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }
  };

  function qrScanLoop() {
    if (scanDetected) return;

    const video = document.getElementById('qr-scan-video');
    const canvas = document.getElementById('qr-scan-canvas');
    if (!video || !canvas || video.readyState < 2) {
      scanAnimId = requestAnimationFrame(qrScanLoop);
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = typeof jsQR !== 'undefined'
      ? jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' })
      : null;

    if (code && code.data) {
      qrScanHandleResult(code.data);
      return;
    }

    scanAnimId = requestAnimationFrame(qrScanLoop);
  }

  function qrScanHandleResult(data) {
    scanDetected = true;
    qrScanStopCamera();

    // Validate it's a maps link or any URL
    const isURL = data.startsWith('http://') || data.startsWith('https://');
    const isMaps = data.includes('maps.google.com') || data.includes('maps.app.goo.gl') || data.includes('google.com/maps') || data.includes('goo.gl/maps');

    if (!isURL) {
      const errEl = document.getElementById('qr-scan-error');
      errEl.textContent = 'QR Code detectado, mas não contém um link válido: ' + data.slice(0, 60);
      errEl.style.display = 'block';
      document.getElementById('qr-scan-start-btn').style.display = 'flex';
      scanDetected = false;
      return;
    }

    scanResultURL = data;
    document.getElementById('qr-scan-url-txt').textContent = data.length > 60 ? data.slice(0, 57) + '...' : data;
    document.getElementById('qr-scan-result').style.display = 'flex';
    document.getElementById('qr-scan-hint').textContent = isMaps ? 'Localização encontrada!' : 'Link detectado!';
  }

  window.qrScanNavigate = function() {
    if (!scanResultURL) return;
    window.open(scanResultURL, '_blank');
  };
})();

// ═══════════════════════════════════════════════════════════════
// LIVE SPY — Rastreamento GPS em tempo real via Firebase RTDB
// ═══════════════════════════════════════════════════════════════

// Helper: Calcula a distância entre dois pontos (Haversine)
function getDistanceInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Raio da Terra em km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Helper: Busca a missão ativa do motorista (status "Em Rota")
async function getDriverActiveMission(uid) {
  try {
    const q = query(
      collection(db, "users", uid, "history"),
      where("status", "==", "Em Rota"),
      orderBy("createdAt", "desc"),
      limit(1)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      return { id: snap.docs[0].id, ...snap.docs[0].data() };
    }
    return null;
  } catch(e) {
    console.warn("Erro ao buscar missão ativa:", e);
    return null;
  }
}

// ── DRIVER SIDE: envia posição silenciosamente ao Firebase RTDB ──
let _gpsWatchId = null;
let _activeMissionCache = null;
let _lastMissionUpdate = 0;

function startDriverGPS() {
  if (!currentUser || window.userRole !== 'driver') return;
  if (!navigator.geolocation) return;

  const adminKey = window.adminId || 'no-admin';
  const posRef = rtdbRef(rtdb, `locations/${adminKey}/${currentUser.uid}`);

  // Obtém nome do motorista do Firestore para exibir no mapa do admin
  getDoc(doc(db, 'users', currentUser.uid)).then(snap => {
    const udata = snap.exists() ? snap.data() : {};
    const driverName = udata.apelido || udata.nome || currentUser.email || 'Motorista';

    _gpsWatchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const now = Date.now();
        const currentLat = pos.coords.latitude;
        const currentLng = pos.coords.longitude;

        // Tenta atualizar o cache da missão a cada 30 segundos (sem bloquear o RTDB)
        if (!_activeMissionCache || (now - _lastMissionUpdate > 30000)) {
          _lastMissionUpdate = now;
          getDriverActiveMission(currentUser.uid).then(m => {
             _activeMissionCache = m;
          }).catch(e => console.warn("Erro ao atualizar missão em background:", e));
        }

        let nearestStop = null;
        if (_activeMissionCache && _activeMissionCache.points && _activeMissionCache.points.length > 0) {
          let minDistance = Infinity;
          
          _activeMissionCache.points.forEach((point, idx) => {
            // Se o ponto tiver coordenadas, calculamos. Caso contrário, ignoramos
            if (point.lat && point.lng) {
              const dist = getDistanceInKm(currentLat, currentLng, point.lat, point.lng);
              if (dist < minDistance) {
                minDistance = dist;
                nearestStop = {
                  name: point.name || `Parada ${idx + 1}`,
                  distance: dist.toFixed(2),
                  index: idx
                };
              }
            }
          });
        }

        try {
          await rtdbSet(posRef, {
            lat: currentLat,
            lng: currentLng,
            speed: pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0, // km/h
            heading: pos.coords.heading || 0,
            accuracy: Math.round(pos.coords.accuracy || 0),
            name: driverName,
            uid: currentUser.uid,
            ts: now,
            nearestStop: nearestStop,
            missionId: _activeMissionCache ? _activeMissionCache.id : null
          });
        } catch(e) { console.warn('GPS RTDB error:', e); }
      },
      (err) => console.warn('GPS watchPosition error:', err),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }).catch(e => console.warn('Failed to get driver name for GPS:', e));
}

function stopDriverGPS() {
  if (_gpsWatchId !== null) {
    navigator.geolocation.clearWatch(_gpsWatchId);
    _gpsWatchId = null;
  }
  // Remove position from RTDB when driver logs out
  if (currentUser && window.adminId) {
    const posRef = rtdbRef(rtdb, `locations/${window.adminId}/${currentUser.uid}`);
    rtdbSet(posRef, null).catch(() => {});
  }
}

// Hook into auth state — start GPS for drivers, stop on logout
const _origHandleLogout = window.handleLogout;
window.handleLogout = async function() {
  stopDriverGPS();
  if (_origHandleLogout) await _origHandleLogout();
};

// Start GPS tracking once role is confirmed as driver
const _spyRoleCheckInterval = setInterval(() => {
  if (currentUser && window.userRole === 'driver') {
    clearInterval(_spyRoleCheckInterval);
    startDriverGPS();
  }
}, 1000);


// ── ADMIN SIDE: modal de espionagem com Leaflet ──
(function() {
  let spyMap = null;
  let spyMarkers = {}; // uid → L.marker
  let spyRtdbRef = null;
  let spyCenterUid = null;
  let spyPolylines = {}; // uid → L.polyline
  let tileLayer = null;

  const DRIVER_COLORS = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63'];
  function colorForIndex(i) { return DRIVER_COLORS[i % DRIVER_COLORS.length]; }

  function buildDriverMarkerSVG(initial, color) {
    return `
      <div style="position: relative; width: 40px; height: 50px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="0 0 40 50">
          <defs>
            <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.4)"/>
            </filter>
          </defs>
          <path d="M20 0 C9 0 0 9 0 20 C0 32 20 50 20 50 C20 50 40 32 40 20 C40 9 31 0 20 0Z" fill="${color}" filter="url(#sh)"/>
          <circle cx="20" cy="19" r="11" fill="white" opacity="0.95"/>
          <text x="20" y="24" text-anchor="middle" font-family="Inter,Arial,sans-serif" font-size="13" font-weight="800" fill="${color}">${initial}</text>
        </svg>
      </div>
    `.trim();
  }

  function timeAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 10) return 'agora';
    if (sec < 60) return `${sec}s atrás`;
    if (sec < 3600) return `${Math.floor(sec/60)}min atrás`;
    return `${Math.floor(sec/3600)}h atrás`;
  }

  function updateMapTheme() {
    if (!spyMap) return;
    if (tileLayer) spyMap.removeLayer(tileLayer);

    const isDark = document.body.classList.contains('dm');
    const url = isDark 
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    
    const attribution = isDark 
        ? '&copy; <a href="https://carto.com/">CARTO</a>'
        : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

    tileLayer = L.tileLayer(url, { attribution }).addTo(spyMap);
  }

  function initSpyMap() {
    if (spyMap) {
      updateMapTheme();
      return;
    }
    
    spyMap = L.map('spy-map', {
      zoomControl: true,
      attributionControl: true
    }).setView([-15.78, -47.93], 13);

    updateMapTheme();
  }

  window.drawSpyRoute = async function(uid, missionId, color) {
    if (!spyMap || !uid || !missionId) return;
    
    if (spyPolylines[uid]) {
      spyMap.removeLayer(spyPolylines[uid]);
    }

    try {
      const missionRef = doc(db, 'users', uid, 'history', missionId);
      const snap = await getDoc(missionRef);
      if (!snap.exists()) return;

      const mData = snap.data();
      const points = mData.points || [];
      if (points.length === 0) return;

      let pathCoords = [];
      if (mData.polyline && window.decodePolyline) {
        pathCoords = window.decodePolyline(mData.polyline);
      } else {
        pathCoords = points.filter(p => p.lat && p.lng).map(p => [p.lat, p.lng]);
      }
      
      const poly = L.polyline(pathCoords, {
        color: color,
        weight: 4,
        opacity: 0.8,
        dashArray: mData.polyline ? null : '10, 5' // Linha continua se tiver trajeto real, tracejada se for linha reta
      }).addTo(spyMap);

      spyPolylines[uid] = poly;
    } catch(e) {
      console.warn("Erro ao desenhar rota espiã:", e);
    }
  };

  function updateDriverPills(driversData) {
    const bar = document.getElementById('spy-driver-bar');
    if (!bar) return;
    bar.innerHTML = '';

    const entries = Object.entries(driversData);
    if (entries.length === 0) {
      bar.innerHTML = '<span style="font-size:11px;color:var(--pr-text-muted);">Nenhum motorista online agora</span>';
      document.getElementById('spy-status-txt').textContent = 'Nenhum motorista online';
      return;
    }

    document.getElementById('spy-status-txt').textContent = `${entries.length} motorista${entries.length > 1 ? 's' : ''} online`;

    entries.forEach(([uid, data], i) => {
      const color = colorForIndex(i);
      const name = data.name || 'Motorista';
      const initial = name.charAt(0).toUpperCase();
      const speed = data.speed || 0;
      const ago = timeAgo(data.ts || Date.now());
      const isSelected = spyCenterUid === uid;

      const nearest = data.nearestStop;
      const nearestText = nearest ? `<div style="font-size:9px;color:${color};font-weight:700;margin-top:2px;">📍 Próximo: ${nearest.name} (${nearest.distance}km)</div>` : '';

      const pill = document.createElement('button');
      pill.style.cssText = `
        display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:20px;
        border:1.5px solid ${isSelected ? color : 'var(--pr-border)'};
        background:${isSelected ? color + '22' : 'var(--pr-bg)'};
        cursor:pointer;white-space:nowrap;flex-shrink:0;font-family:var(--font-main);
        transition:all 0.15s;
      `;
      pill.innerHTML = `
        <div style="width:22px;height:22px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;">
          <span style="font-size:11px;font-weight:800;color:#fff;">${initial}</span>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--pr-text);">${escapeHTML(name)}</div>
          <div style="font-size:10px;color:var(--pr-text-muted);">${speed} km/h · ${ago}</div>
          ${nearestText}
        </div>
      `;
      pill.onclick = () => {
        spyCenterUid = uid;
        if (spyMap && data.lat && data.lng) {
          spyMap.flyTo([data.lat, data.lng], 16);
          if (data.missionId) window.drawSpyRoute(uid, data.missionId, color);
        }
        updateDriverPills(driversData);
      };
      bar.appendChild(pill);
    });
  }

  function updateDriverMarkers(driversData) {
    if (!spyMap) return;
    const latlngs = [];

    // Remove markers for drivers no longer present
    Object.keys(spyMarkers).forEach(uid => {
      if (!driversData[uid]) {
        spyMap.removeLayer(spyMarkers[uid]);
        delete spyMarkers[uid];
      }
    });

    Object.entries(driversData).forEach(([uid, data], i) => {
      if (!data.lat || !data.lng) return;
      const pos = [data.lat, data.lng];
      const color = colorForIndex(i);
      const name = data.name || 'Motorista';
      const initial = name.charAt(0).toUpperCase();
      const speed = data.speed || 0;
      const ago = timeAgo(data.ts || Date.now());

      const nearest = data.nearestStop;
      const nearestHTML = nearest ? `<div style="font-size:11px;color:${color};font-weight:700;margin-top:4px;">📍 Próximo: ${nearest.name} (${nearest.distance}km)</div>` : '';

      const svgIcon = L.divIcon({
        html: buildDriverMarkerSVG(initial, color),
        className: 'custom-driver-marker',
        iconSize: [40, 50],
        iconAnchor: [20, 50],
        popupAnchor: [0, -45]
      });

      const popupContent = `
        <div style="font-family:Inter,Arial,sans-serif;padding:4px 2px;min-width:160px;">
          <div style="font-weight:700;font-size:13px;color:#1a2b3d;margin-bottom:4px;">${escapeHTML(name)}</div>
          <div style="font-size:11px;color:#6B7C8E;margin-bottom:2px;">🚗 ${speed} km/h</div>
          <div style="font-size:11px;color:#6B7C8E;margin-bottom:4px;">⏱ ${ago}</div>
          ${nearestHTML}
          <a href="https://www.google.com/maps?q=${data.lat},${data.lng}" target="_blank"
            style="font-size:11px;color:#1A6BAF;font-weight:600;">Ver no Google Maps ↗</a>
        </div>
      `;

      if (spyMarkers[uid]) {
        spyMarkers[uid].setLatLng(pos);
        spyMarkers[uid].setIcon(svgIcon);
        spyMarkers[uid].setPopupContent(popupContent);
      } else {
        const marker = L.marker(pos, { icon: svgIcon }).addTo(spyMap);
        marker.bindPopup(popupContent);
        marker.on('click', () => {
          spyCenterUid = uid;
          updateDriverPills(driversData);
        });
        spyMarkers[uid] = marker;
      }

      latlngs.push(pos);
    });

    if (latlngs.length > 0) {
      if (spyCenterUid && driversData[spyCenterUid]) {
        const d = driversData[spyCenterUid];
        spyMap.panTo([d.lat, d.lng]);
      } else if (!spyCenterUid && Object.keys(spyMarkers).length > 0) {
        const bounds = L.latLngBounds(latlngs);
        spyMap.fitBounds(bounds, { padding: [50, 50] });
      }
    }
  }

  window.openLiveSpy = function(targetUid) {
    document.getElementById('liveSpyModal').classList.add('active');
    spyCenterUid = targetUid || null;

    setTimeout(() => {
      initSpyMap();

      const adminKey = window.companyId || (currentUser && currentUser.uid);
      if (!adminKey) {
        document.getElementById('spy-status-txt').textContent = 'Erro: admin não identificado';
        return;
      }

      spyRtdbRef = rtdbRef(rtdb, `locations/${adminKey}`);
      onValue(spyRtdbRef, (snapshot) => {
        const raw = snapshot.val() || {};
        updateDriverPills(raw);
        updateDriverMarkers(raw);
        
        if (spyCenterUid && raw[spyCenterUid]) {
          const loc = raw[spyCenterUid];
          if (loc.lat && loc.lng && spyMap) {
            spyMap.setView([loc.lat, loc.lng], 16);
            spyCenterUid = null;
          }
        }
      }, (err) => {
        console.warn('RTDB spy error:', err);
        document.getElementById('spy-status-txt').textContent = 'Erro ao conectar ao RTDB';
      });
    }, 200); 
  };

  window.closeLiveSpy = function() {
    document.getElementById('liveSpyModal').classList.remove('active');
    if (spyRtdbRef) {
      off(spyRtdbRef);
      spyRtdbRef = null;
    }
    Object.values(spyPolylines).forEach(p => spyMap.removeLayer(p));
    spyPolylines = {};
    Object.values(spyMarkers).forEach(m => spyMap.removeLayer(m));
    spyMarkers = {};
  };

  // --- DRIVER STATS LOGIC ---
  window.openDriverStats = async function(uid, name) {
    const modal = document.getElementById('driverStatsModal');
    if (!modal) return;
    
    modal.classList.add('active');
    document.getElementById('statsDriverName').textContent = name;
    document.getElementById('statsDriverAvatar').textContent = name.charAt(0).toUpperCase();
    
    const listContainer = document.getElementById('statsHistoryList');
    listContainer.innerHTML = '<div style="text-align:center; padding:40px; color:var(--pr-text-muted); font-size:12px;">⏳ Analisando rotas...</div>';
    
    try {
      const q = query(
        collection(db, "users", uid, "history"),
        orderBy("createdAt", "desc"),
        limit(20)
      );
      
      const snap = await getDocs(q);
      let totalRoutes = 0;
      let totalStops = 0;
      
      if (snap.empty) {
        listContainer.innerHTML = '<div style="text-align:center; padding:40px; color:var(--pr-text-muted); font-size:12px;">Nenhuma rota encontrada para este motorista.</div>';
        document.getElementById('statTotalRoutes').textContent = '0';
        document.getElementById('statTotalStops').textContent = '0';
        return;
      }
      
      listContainer.innerHTML = '';
      
      snap.forEach(docSnap => {
        const data = docSnap.data();
        if (data.status === 'CONCLUDED' || data.status === 'Concluída') {
          totalRoutes++;
          totalStops += (data.stopsCount || (data.stops ? data.stops.length : 0));
        }
        
        const date = data.createdAt ? data.createdAt.toDate().toLocaleDateString('pt-BR') : '—';
        const stops = data.stopsCount || (data.stops ? data.stops.length : 0);
        const statusClass = (data.status === 'CONCLUDED' || data.status === 'Concluída') ? 'concluded' : 'pending';
        const statusLabel = (data.status === 'CONCLUDED' || data.status === 'Concluída') ? 'Concluída' : data.status;

        const item = document.createElement('div');
        item.className = 'stats-history-card';
        item.innerHTML = `
          <div class="history-info">
            <div class="history-date">${date}</div>
            <div class="history-meta">${stops} paradas • ${data.distance || '—'} km</div>
          </div>
          <div class="history-status ${statusClass}">${statusLabel}</div>
        `;
        listContainer.appendChild(item);
      });
      
      document.getElementById('statTotalRoutes').textContent = totalRoutes;
      document.getElementById('statTotalStops').textContent = totalStops;
      
    } catch (err) {
      console.error("Erro ao carregar estatísticas:", err);
      listContainer.innerHTML = '<div style="text-align:center; padding:40px; color:var(--pr-text-muted); font-size:12px;">Erro ao carregar dados.</div>';
    }
  };

  window.closeDriverStatsModal = function() {
    const modal = document.getElementById('driverStatsModal');
    if (modal) modal.classList.remove('active');
  };

})();
