import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc, onSnapshot, query, orderBy, limit, deleteDoc, serverTimestamp, arrayUnion, arrayRemove, where, getDocs, writeBatch, increment } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { getDatabase, ref as rtdbRef, set as rtdbSet, onValue, off, remove as rtdbRemove } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-database.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-storage.js";
import CONFIG from "./config.js";

const app = initializeApp(CONFIG.firebase);
const auth = getAuth(app);
const db = getFirestore(app);
const rtdb = getDatabase(app);
const storage = getStorage(app);
let currentUser = null;
let allLocations = [];
let builderSelectedPoints = [];
let userCoords = null;
let driverMissionsUnsubscribe = null;
let deliveryPhotoBuffer = null;
let currentMissionIdForCompletion = null;

// ══════════════════════════════════════════════════════════
// UTILS & NOTIFICATIONS
// ══════════════════════════════════════════════════════════
// Helper Sênior: Detectar Mobile/Touch
const isMobileDevice = () => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
const isTouchDevice = () => ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

window.showToast = (message, type = 'info') => {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'warning') icon = '⚠️';
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
};

// --- CONFIRM MODAL (PREMIUM) ---
window.showConfirm = function(message, title = "Confirmação", icon = "❓") {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    const msgEl = document.getElementById('confirmMessage');
    const titleEl = document.getElementById('confirmTitle');
    const iconEl = document.getElementById('confirmIcon');
    const cancelBtn = document.getElementById('confirmCancelBtn');
    const confirmBtn = document.getElementById('confirmConfirmBtn');

    if (!modal) {
      resolve(confirm(message));
      return;
    }

    msgEl.textContent = message;
    titleEl.textContent = title;
    iconEl.textContent = icon;

    modal.classList.add('active');

    const cleanup = (result) => {
      modal.classList.remove('active');
      cancelBtn.onclick = null;
      confirmBtn.onclick = null;
      resolve(result);
    };

    cancelBtn.onclick = () => cleanup(false);
    confirmBtn.onclick = () => cleanup(true);
  });
};

// Caching para regras de comissão
window._commissionRulesCache = null;
window._commissionRulesLastFetch = 0;

// Sanitização XSS — escapa HTML em conteúdo dinâmico
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

/**
 * Utilitário Sênior: Extrai coordenadas de uma URL do Google Maps (fallback client-side).
 */
window.extractCoordsFromUrl = function(url) {
  if (!url || typeof url !== 'string') return null;
  const patterns = [
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/
  ];
  for (const p of patterns) {
    const match = url.match(p);
    if (match) return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
  return null;
};

/**
 * Utilitário Sênior: Formata um local para uso em URLs do Google Maps (Directions/Search).
 * Prioriza coordenadas para evitar ambiguidades e filtra links brutos.
 */
window.formatMapsLocation = function(loc) {
  if (!loc) return '';
  
  // 1. Prioridade Máxima: Coordenadas (lat,lng)
  let lat = loc.lat ?? loc.coords?.lat;
  let lng = loc.lng ?? loc.coords?.lng;
  
  const input = loc.originalInput || loc.input || '';

  // Se não tem coords, tenta extrair do input se for um link
  if ((lat === null || lat === undefined) && input.includes('http')) {
    const extracted = window.extractCoordsFromUrl(input);
    if (extracted) {
      lat = extracted.lat;
      lng = extracted.lng;
    }
  }
  
  if (lat !== null && lat !== undefined && lng !== null && lng !== undefined) {
    return `${lat},${lng}`;
  }
  
  // 2. Fallback para Texto (Nome ou Endereço)
  const name = loc.name || '';
  
  // Detecta se o input é uma URL (não queremos mandar uma URL como waypoint)
  const isUrl = (str) => {
    if (!str || typeof str !== 'string') return false;
    return str.startsWith('http') || str.includes('google.com/maps') || str.includes('goo.gl/maps');
  };

  // Se o input original for um link e não conseguimos extrair coords, preferimos usar o nome
  if (isUrl(input)) {
    return encodeURIComponent(name || 'Local');
  }
  
  // Se for um endereço de texto, usamos o input
  if (input && input.length > 3) {
    return encodeURIComponent(input);
  }
  
  return encodeURIComponent(name || 'Local');
};

// Sanitização de URL — previne injeção de javascript: em links
function sanitizeUrl(url) {
  if (!url) return '';
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? url : ''; }
  catch(e) { return ''; }
}

// Gera iniciais a partir do nome
function getInitials(name) {
  if (!name) return "--";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "--";
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// Função para sincronizar as iniciais no MODAL (Prioridade para Nome Completo)
window.syncProfileInitials = () => {
  const nameInput = document.getElementById('profileName');
  const circle = document.getElementById('profileInitialsCircle');
  
  const nameVal = nameInput ? nameInput.value.trim() : "";
  
  // No modal, o usuário quer que o NOME COMPLETO tenha prioridade total.
  const textToProcess = nameVal || (currentUser ? currentUser.email : "") || "--";
  
  if (circle) {
    circle.textContent = getInitials(textToProcess);
  }
};

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
window.companyId = null;

// Helper para validar permissões
window.checkRole = function(role) {
  if (window.userRole !== role) {
    console.warn(`[Permissões] Acesso negado para ${role}. Atual: ${window.userRole}`);
    showToast("Acesso Negado: Permissão insuficiente.", "error");
    return false;
  }
  return true;
};

// ══════════════════════════════════════════════════════════
// GLOBAL LOADER & FAIL-SAFE
// ══════════════════════════════════════════════════════════
window.hideLoader = () => {
  const loader = document.getElementById('appLoader');
  if (loader) loader.style.display = 'none';
  const shell = document.getElementById('shell');
  if (shell) shell.style.visibility = 'visible';
  if (window._loaderFailSafe) clearTimeout(window._loaderFailSafe);
};

window._loaderFailSafe = setTimeout(() => {
  console.warn("Global Fail-safe: Excedido tempo de inicialização.");
  window.hideLoader();
}, 10000);

// ══════════════════════════════════════════════════════════
// MENSAGEM MOTIVACIONAL — SINCRONIZADA COM O DIA DA SEMANA
// ══════════════════════════════════════════════════════════
const MENSAGENS_SEMANA = {
  0: { emoji: "🌟", titulo: "Bom domingo, equipe!", texto: "Descanso é parte da jornada. Recarregue as energias — amanhã a estrada nos espera com tudo!" },
  1: { emoji: "🚀", titulo: "Segunda-feira: Pé no acelerador!", texto: "Nova semana, novas metas. Vamos fazer cada entrega valer a pena com foco e segurança." },
  2: { emoji: "🎯", titulo: "Terça-feira: Foco no destino!", texto: "A constância é o que leva ao sucesso. Continue firme, seu trabalho move o mundo." },
  3: { emoji: "⚡", titulo: "Quarta-feira: Meio da jornada!", texto: "Mantenha o ritmo! O que você faz com excelência hoje, colhe amanhã em reconhecimento." },
  4: { emoji: "🛣️", titulo: "Quinta-feira: Quase lá!", texto: "Sua dedicação é o motor que nos faz chegar mais longe. Ótimo trabalho até aqui!" },
  5: { emoji: "🏁", titulo: "Sexta-feira: Reta final!", texto: "Finalize a semana com a mesma energia que começou. Compromisso e agilidade sempre." },
  6: { emoji: "🛡️", titulo: "Sábado: Segurança primeiro!", texto: "Mesmo no fim de semana, sua segurança é nossa prioridade. Dirija com cuidado e bom trabalho!" }
};

function aplicarMensagemDaSemana(idElemento) {
  const container = document.getElementById(idElemento);
  if (!container) return;
  
  const diasNomes = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
  const diaIndex = new Date().getDay();
  const msg = MENSAGENS_SEMANA[diaIndex];
  
  if (!msg) return;

  container.innerHTML = `
    <div class="motiv-card">
      <div class="motiv-header">
        <span class="motiv-emoji">${msg.emoji}</span>
        <span class="motiv-title">${msg.titulo}</span>
      </div>
      <p class="motiv-text">${msg.texto}</p>
      <span class="motiv-day">${diasNomes[diaIndex]}</span>
    </div>
  `;
}

async function applyRoleUI() {
  console.log("Seu nível de acesso detectado:", window.userRole);
  
  const cardMotivacional = document.getElementById('cardMotivacional');
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
  const commissionRulesBtn = document.getElementById('commissionRulesBtn');
  
  if (window.userRole === "admin") {
    document.body.classList.add('is-admin');
    // ═══ ADMIN VIEW ═══
    if (adminPanel) adminPanel.style.display = '';
    if (driverPanel) driverPanel.style.display = 'none';
    if (adminHubBtn) adminHubBtn.style.display = 'flex';
    if (fleetManageBtn) fleetManageBtn.style.display = 'flex';
    const liveSpyBtn = document.getElementById('liveSpyBtn');
    if (liveSpyBtn) liveSpyBtn.style.display = 'flex';
    if (commissionRulesBtn) commissionRulesBtn.style.display = 'flex';
    const monthlyGoalsBtn = document.getElementById('monthlyGoalsBtn');
    if (monthlyGoalsBtn) monthlyGoalsBtn.style.display = 'flex';
    if (bottomNavAdmin) bottomNavAdmin.style.display = '';
    if (bottomNavDriver) bottomNavDriver.style.display = 'none';
    if (adminArea) adminArea.style.display = 'flex';
    if (dailyRouteCard) {
      dailyRouteCard.style.display = '';
    }
    if (adminFleetCard) adminFleetCard.style.display = 'none';
    const adminMsg = document.getElementById('adminCardMessage');
    if (adminMsg) adminMsg.style.display = 'block';
    
    // Show and populate motivational card for Admin
    if (cardMotivacional) {
      cardMotivacional.style.display = 'block';
      aplicarMensagemDaSemana('cardMotivacional');
    }
    
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
            const displayName = u.nome || 'Motorista sem nome';
            const initial = displayName.charAt(0).toUpperCase();
            window._fleetDrivers.push({uid: docSnap.id, nome: u.nome, email: u.email});
            
            const label = document.createElement('label');
            label.className = 'bdr-item';
            label.dataset.uid = docSnap.id;
            label.dataset.name = displayName;
            
            // Premium style for driver selection
            label.innerHTML = `
              <input type="radio" name="driverRadio" value="${docSnap.id}" class="bdr-radio"/>
              <div class="bdr-avatar" style="background: linear-gradient(135deg, var(--pr-blue-dark), var(--pr-blue-mid)); color: #fff; font-weight: 800;">${initial}</div>
              <div class="bdr-info">
                <div class="bdr-name" style="font-size:15px; font-weight:700; color:var(--pr-text);">${escapeHTML(displayName)}</div>
                <div class="bdr-email" style="font-size:11px; color:var(--pr-text-muted);">${escapeHTML(u.email || '')}</div>
              </div>
              <div style="flex-shrink: 0; display:flex; align-items:center; gap:6px;">
                <div style="width: 8px; height: 8px; border-radius: 50%; background: #27ae60; box-shadow: 0 0 8px rgba(39, 174, 96, 0.4);"></div>
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
    document.body.classList.remove('is-admin');
    // ═══ DRIVER VIEW ═══
    if (adminPanel) adminPanel.style.display = 'none';
    if (driverPanel) driverPanel.style.display = '';
    if (adminHubBtn) adminHubBtn.style.display = 'none';
    if (fleetManageBtn) fleetManageBtn.style.display = 'none';
    if (bottomNavAdmin) bottomNavAdmin.style.display = 'none';
    if (bottomNavDriver) bottomNavDriver.style.display = '';
    if (adminArea) adminArea.style.display = 'none';
    if (dailyRouteCard) {
      dailyRouteCard.style.display = '';
    }
    if (adminFleetCard) adminFleetCard.style.display = 'none'; // Hide fleet card
    
    // Start listening for driver missions
    loadDriverMissions();
    
    // Hide motivational card for Driver
    if (cardMotivacional) cardMotivacional.style.display = 'none';
  }
}

// ══════════════════════════════════════════════════════════
// DRIVER: carregar missões recebidas em tempo real
// ══════════════════════════════════════════════════════════

function loadDriverMissions() {
  if (!currentUser) return;
  
  // Unsubscribe from previous listener to avoid memory leaks and duplicate updates
  if (driverMissionsUnsubscribe) {
    driverMissionsUnsubscribe();
    driverMissionsUnsubscribe = null;
  }
  
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
      
      const stopsCount = data.stopsCount || 0;
      const mapsUrl = sanitizeUrl(data.mapsUrl);
      
      // Track first pending/active route for sidebar preview
      if ((status === "Pendente" || status === "Em Rota") && !pendingOrActiveRoute) {
        pendingOrActiveRoute = { data, missionId, status, stColor };
      }

      // Build stop names
      let stopNames = "";
      if (data.points && data.points.length > 0) {
        stopNames = data.points.map((p, i) => `${i+1}. ${p.name || 'Local'}`).join(" → ");
      }
      
      let startedTimeHTML = '';
      if (data.startedAt && data.startedAt.toDate) {
        const dObj = data.startedAt.toDate();
        startedTimeHTML = `<span style="color:#2196f3; font-weight:600; background:rgba(33, 150, 243, 0.1); padding:2px 6px; border-radius:4px;">Saída: ${dObj.toLocaleDateString('pt-BR')} às ${dObj.toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}</span>`;
      }
      
      const card = document.createElement('div');
      card.style.cssText = "background: var(--pr-surface); border: 1px solid var(--pr-border); border-radius: 12px; padding: 14px; border-left: 4px solid " + stColor + "; transition: transform 0.15s;";
      card.onmouseover = function() { this.style.transform = 'translateX(3px)'; };
      card.onmouseout = function() { this.style.transform = 'translateX(0)'; };
      
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div class="text-dark-auto" style="font-size: 13px; font-weight: 700;">Rota #${missionId.substring(0,6)}</div>
          <span style="font-size: 10px; background: ${stColor}; color: #fff; padding: 2px 8px; border-radius: 10px; font-weight: bold;">${status.toUpperCase()}</span>
        </div>
        ${data.assignedByName ? `<div style="font-size: 10px; color: var(--pr-blue-mid); font-weight: 600; margin-bottom: 6px;">Enviada por: ${escapeHTML(data.assignedByName)}</div>` : ''}
        <div style="font-size: 11px; color: var(--pr-text-muted); margin-bottom: 6px; line-height: 1.5;">${escapeHTML(stopNames) || 'Sem detalhes'}</div>
        <div style="display: flex; gap: 12px; flex-wrap: wrap; font-size: 10px; color: var(--pr-text-muted); margin-bottom: 10px;">
          <span>Paradas: ${stopsCount}</span>
          ${startedTimeHTML}
          ${(data.expectedWeight !== undefined && data.expectedWeight !== null) ? `<span style="color:#27ae60; font-weight:700;" title="Carga Programada (Peso)">Peso Restante: ${data.expectedWeight.toFixed(2)}kg</span>` : ''}
          ${(data.expectedValue !== undefined && data.expectedValue !== null) ? `<span style="color:#e67e22; font-weight:700;" title="Carga Programada (Valor)">Valor Restante: R$ ${data.expectedValue.toFixed(2)}</span>` : ''}
        </div>
        <div style="display: flex; gap: 6px;">
          ${mapsUrl ? `<a href="${mapsUrl}" target="_blank" onclick="window.startMission('${missionId}')" style="flex: 1; display: block; background: var(--pr-blue-dark); color: #fff; text-decoration: none; text-align: center; padding: 8px; border-radius: 8px; font-size: 11px; font-weight: 600; transition: opacity 0.15s;" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'">Abrir Maps</a>` : ''}
          ${status !== "Concluída" ? `<button onclick="event.stopPropagation(); window.finishMission('${missionId}')" style="flex-shrink: 0; background: #27ae60; color: #fff; border: none; padding: 8px 14px; border-radius: 8px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: inherit; transition: opacity 0.15s;" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'">Concluir Entrega</button>` : ''}
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
        const stopNames = (d.points || []).map(p => p.name || 'Local').join(' → ');
        activeRouteContainer.innerHTML = `
          <div style="background: var(--pr-surface); border: 1px solid var(--pr-border); border-radius: 10px; padding: 12px; border-left: 3px solid ${stc};">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <div class="text-dark-auto" style="font-size: 12px; font-weight: 700;">Rota #${mid.substring(0,6)}</div>
              <span style="font-size: 9px; background: ${stc}; color: #fff; padding: 2px 6px; border-radius: 8px; font-weight: bold;">${pendingOrActiveRoute.status.toUpperCase()}</span>
            </div>
            ${d.assignedByName ? `<div style="font-size: 9px; color: var(--pr-blue-mid); font-weight: 600; margin-bottom: 5px;">Enviada por: ${escapeHTML(d.assignedByName)}</div>` : ''}
            <div style="font-size: 10px; color: var(--pr-text-muted); margin-bottom: 8px; line-height: 1.4;">${escapeHTML(stopNames)}</div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap; font-size: 9px; color: var(--pr-text-muted); margin-bottom: 10px;">
              <span>Paradas: ${d.stopsCount || 0}</span>
              ${d.startedAt && d.startedAt.toDate ? `<span style="color:#2196f3; font-weight:600; background:rgba(33,150,243,0.1); padding:2px 6px; border-radius:4px;">Saída: ${d.startedAt.toDate().toLocaleDateString('pt-BR')} às ${d.startedAt.toDate().toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'})}</span>` : ''}
              ${(d.expectedWeight !== undefined && d.expectedWeight !== null) ? `<span style="color:#27ae60; font-weight:700;">Peso Rest: ${d.expectedWeight.toFixed(2)}kg</span>` : ''}
              ${(d.expectedValue !== undefined && d.expectedValue !== null) ? `<span style="color:#e67e22; font-weight:700;">Valor Rest: R$ ${d.expectedValue.toFixed(2)}</span>` : ''}
            </div>
            <div style="display: flex; gap: 6px;">
              ${d.mapsUrl ? `<a href="${d.mapsUrl}" target="_blank" onclick="window.startMission('${mid}')" style="flex:1; display:block; background:var(--pr-blue-dark); color:#fff; text-decoration:none; text-align:center; padding:7px; border-radius:7px; font-size:10px; font-weight:600;">Abrir Maps</a>` : ''}
              ${pendingOrActiveRoute.status !== "Concluída" ? `<button onclick="event.stopPropagation(); window.finishMission('${mid}')" style="flex:1; background:#27ae60; color:#fff; border:none; padding:7px; border-radius:7px; font-size:10px; font-weight:600; cursor:pointer; font-family:inherit;">Concluir Entrega</button>` : ''}
            </div>
          </div>
        `;
      } else {
        activeRouteContainer.innerHTML = `<div style="padding: 15px; text-align: center; font-size: 11px; color: var(--pr-text-muted); opacity: 0.6;">Todas as rotas concluídas!</div>`;
      }
    }
    
    // Update daily route card
    const dailyRouteCard = document.getElementById('dailyRouteCard');
    if (dailyRouteCard) {
      if (pendingOrActiveRoute) {
        window.currentActiveRouteUrl = pendingOrActiveRoute.data.mapsUrl;
        window.currentActiveMissionId = pendingOrActiveRoute.missionId; 
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
    const batch = writeBatch(db);
    
    // 1. Update Subcollection (History)
    const historyRef = doc(db, "users", currentUser.uid, "history", missionId);
    batch.update(historyRef, updatePayload);
    
    // 2. Update Parent User Doc (Denormalization)
    const userRef = doc(db, "users", currentUser.uid);
    batch.update(userRef, {
      currentStatus: status,
      lastStatusUpdate: serverTimestamp(),
      // Denormalizar resumo para o Monitoramento Admin (Evita queries extras)
      lastRouteSummary: {
        id: missionId,
        status: status,
        updatedAt: serverTimestamp(),
        stopsCount: extraData.stopsCount || null, // Mantém se enviado
        expectedWeight: extraData.expectedWeight !== undefined ? extraData.expectedWeight : null,
        expectedValue: extraData.expectedValue !== undefined ? extraData.expectedValue : null
      }
    });
    
    await batch.commit();
    console.log(`Status sincronizado via Batch: ${status}`);
  } catch(e) {
    console.warn("Erro ao sincronizar status em lote:", e);
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
  currentMissionIdForCompletion = missionId;
  
  // Limpar dados anteriores
  const expectedBox = document.getElementById('expectedCargoInfo');
  const expWeight = document.getElementById('displayExpectedWeight');
  const expValue = document.getElementById('displayExpectedValue');
  
  if (expectedBox) expectedBox.style.display = 'none';
  if (expWeight) expWeight.textContent = '-- kg';
  if (expValue) expValue.textContent = 'R$ --';

  // Buscar dados da missão para mostrar o peso/valor esperado
  try {
    const missionRef = doc(db, "users", currentUser.uid, "history", missionId);
    const snap = await getDoc(missionRef);
    
    if (snap.exists()) {
      const data = snap.data();
      if (data.expectedWeight || data.expectedValue) {
        if (expectedBox) expectedBox.style.display = 'block';
        if (expWeight) expWeight.textContent = `${data.expectedWeight || 0} kg`;
        if (expValue) expValue.textContent = `R$ ${(data.expectedValue || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
      }
    }
  } catch (e) {
    console.error("Erro ao carregar detalhes da missão:", e);
  }

  document.getElementById('deliveryCompletionModal').classList.add('active');
};

window.handleDeliveryPhotoChange = function(input) {
  const file = input.files[0];
  const preview = document.getElementById('photoPreview');
  const placeholder = document.getElementById('photoPlaceholder');
  const changeBtn = document.getElementById('changePhotoBtn');
  
  if (file) {
    deliveryPhotoBuffer = file;
    const reader = new FileReader();
    reader.onload = function(e) {
      if (preview) {
        preview.src = e.target.result;
        preview.style.display = 'block';
      }
      if (placeholder) placeholder.style.display = 'none';
      if (changeBtn) changeBtn.style.display = 'block';
    };
    reader.readAsDataURL(file);
  }
};

window.closeDeliveryModal = function() {
  const modal = document.getElementById('deliveryCompletionModal');
  if (modal) modal.classList.remove('active');
  
  // Reset fields
  const weightInput = document.getElementById('deliveryWeight');
  const valueInput = document.getElementById('deliveryValue');
  const notesInput = document.getElementById('deliveryNotes');
  const photoInput = document.getElementById('deliveryPhotoInput');
  const preview = document.getElementById('photoPreview');
  const placeholder = document.getElementById('photoPlaceholder');
  const changeBtn = document.getElementById('changePhotoBtn');

  if (weightInput) weightInput.value = '';
  if (valueInput) valueInput.value = '';
  if (notesInput) notesInput.value = '';
  if (photoInput) photoInput.value = '';
  if (preview) {
    preview.src = '';
    preview.style.display = 'none';
  }
  if (placeholder) placeholder.style.display = 'flex';
  if (changeBtn) changeBtn.style.display = 'none';
  
  deliveryPhotoBuffer = null;
  currentMissionIdForCompletion = null;
};

window.confirmDelivery = async function() {
  if (!currentMissionIdForCompletion) return;
  if (!currentUser) {
    showToast("Erro: Usuário não autenticado.", "warning");
    return;
  }
  
  const weightVal = document.getElementById('deliveryWeight').value;
  const cargoVal = document.getElementById('deliveryValue').value;
  const notes = document.getElementById('deliveryNotes').value;
  const btn = document.getElementById('btnConfirmDelivery');
  
  const weight = parseFloat(weightVal);
  const cargoValue = parseFloat(cargoVal) || 0;
  
  if (isNaN(weight) || weight <= 0) {
    showToast("Informe o peso da mercadoria.", "warning");
    document.getElementById('deliveryWeight').focus();
    return;
  }

  if (!deliveryPhotoBuffer) {
    showToast("A foto do comprovante é obrigatória.", "warning");
    document.getElementById('deliveryPhotoInput').click();
    return;
  }

  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:center; gap:8px;">
      <span class="status-pulse blue" style="margin-right:0;"></span>
      Finalizando...
    </div>
  `;

  try {
    console.log("[Delivery] Iniciando confirmação de entrega...");
    let photoUrl = null;
    const storagePath = `deliveries/${window.companyId || currentUser.uid}/${currentMissionIdForCompletion}_${Date.now()}.jpg`;
    const sRef = storageRef(storage, storagePath);
    
    // Upload photo
    console.log("[Delivery] Iniciando upload da foto...");
    const snapshot = await uploadBytes(sRef, deliveryPhotoBuffer);
    photoUrl = await getDownloadURL(snapshot.ref);

    // Calcular comissão
    console.log("[Delivery] Calculando comissão...");
    const commission = await calculateCommissionValue(weight);

    // Deduzir da meta mensal
    if (typeof window.deductFromMonthlyGoal === 'function') {
      await window.deductFromMonthlyGoal(weight, cargoValue);
    }

    // Buscar rota atual
    const routeDocRef = doc(db, "users", currentUser.uid, "history", currentMissionIdForCompletion);
    const routeSnap = await getDoc(routeDocRef);
    let isFullyCompleted = true;
    let newExpectedWeight = 0;
    let newExpectedValue = 0;

    if (routeSnap.exists()) {
      const data = routeSnap.data();
      newExpectedWeight = Math.max(0, (data.expectedWeight || 0) - weight);
      newExpectedValue = Math.max(0, (data.expectedValue || 0) - cargoValue);
      if (newExpectedWeight > 0 || newExpectedValue > 0) isFullyCompleted = false;
    }

    const finalStatus = isFullyCompleted ? "Concluída" : "Pendente";

    // Buscar valores acumulados
    const currentDeliveredWeight = (routeSnap.exists() ? routeSnap.data().deliveredWeight : 0) || 0;
    const currentDeliveredValue = (routeSnap.exists() ? routeSnap.data().deliveredValue : 0) || 0;
    const currentTotalCommission = (routeSnap.exists() ? routeSnap.data().totalCommission : 0) || 0;

    // --- OPERAÇÃO ATÔMICA (BATCH) ---
    console.log("[Delivery] Gravando dados atômicamente...");
    const batch = writeBatch(db);

    // 1. Atualizar documento da rota (History)
    const routePayload = {
      status: finalStatus,
      completedAt: serverTimestamp(),
      lastWeight: weight,
      lastValue: cargoValue,
      deliveredWeight: currentDeliveredWeight + weight,
      deliveredValue: currentDeliveredValue + cargoValue,
      deliveryNotes: notes,
      proofPhotoUrl: photoUrl,
      totalCommission: currentTotalCommission + commission,
      finishedBy: currentUser.uid,
      expectedWeight: newExpectedWeight, 
      expectedValue: newExpectedValue
    };
    batch.update(routeDocRef, routePayload);

    // 2. Atualizar perfil do usuário (Denormalização e Estatísticas)
    const userRef = doc(db, "users", currentUser.uid);
    batch.update(userRef, {
      currentStatus: finalStatus,
      lastStatusUpdate: serverTimestamp(),
      lastRouteSummary: {
        id: currentMissionIdForCompletion,
        status: finalStatus,
        updatedAt: serverTimestamp(),
        expectedWeight: newExpectedWeight,
        expectedValue: newExpectedValue
      },
      // Incrementos vitalícios
      perfTotalWeight:     increment(weight),
      perfTotalValue:      increment(cargoValue),
      perfTotalCommission: increment(commission),
      perfTotalCompleted:  increment(1),
      perfLastDeliveryAt:  serverTimestamp()
    });

    await batch.commit();

    showToast("Entrega registrada com sucesso!", "success");
    window.closeDeliveryModal();
    if (window.loadDriverMissions) window.loadDriverMissions();
    
  } catch (e) {
    console.error("[Delivery] Erro crítico:", e);
    showToast("Erro ao salvar entrega: " + (e.message || "Verifique sua conexão."), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
};

async function calculateCommissionValue(weight) {
  if (!window.companyId) {
    console.warn("[Comm] companyId não definido, usando comissão 0.");
    return 0;
  }
  try {
    const q = query(collection(db, "commission_rules"), where("companyId", "==", window.companyId));
    const snapshot = await getDocs(q);
    let fee = 0;
    
    const today = new Date().getDate();
    
    snapshot.forEach(docSnap => {
      const rule = docSnap.data();
      const start = rule.cycleStart || 1;
      const end = rule.cycleEnd || 31;
      
      let inCycle = false;
      if (start <= end) {
        inCycle = today >= start && today <= end;
      } else {
        inCycle = today >= start || today <= end;
      }
      
      if (inCycle) {
        if (weight >= rule.min && weight <= rule.max) {
          fee = rule.value;
        }
      }
    });
    
    return fee;
  } catch (e) {
    console.warn("Erro ao calcular comissão:", e);
    return 0;
  }
}

// --- ADMIN: Regras de Comissão ---

window.openCommissionRulesModal = function() {
  if (!checkRole('admin')) return;
  document.getElementById('commissionRulesModal').classList.add('active');
  window.loadCommissionRules();
};

window.closeCommissionRulesModal = function() {
  document.getElementById('commissionRulesModal').classList.remove('active');
};

window.saveCommissionRule = async function() {
  if (!checkRole('admin')) {
    showToast("Acesso negado: Somente administradores.", "error");
    return;
  }
  
  const titleInput = document.getElementById('ruleTitle');
  const startInput = document.getElementById('ruleStartDay');
  const endInput = document.getElementById('ruleEndDay');
  const minInput = document.getElementById('ruleMinWeight');
  const maxInput = document.getElementById('ruleMaxWeight');
  const valInput = document.getElementById('ruleValue');

  if (!titleInput || !startInput || !endInput || !minInput || !maxInput || !valInput) {
    console.error("IDs de input não encontrados no DOM.");
    return;
  }

  const title = titleInput.value.trim() || 'Regra Padrao';
  const cycleStart = parseInt(startInput.value) || 1;
  const cycleEnd = parseInt(endInput.value) || 31;
  const min = parseFloat(minInput.value);
  const max = parseFloat(maxInput.value);
  const val = parseFloat(valInput.value);
  
  if (isNaN(min) || isNaN(max) || isNaN(val)) {
    showToast("Preencha todos os campos da faixa.", "warning");
    return;
  }

  const cId = window.companyId || (currentUser ? currentUser.uid : null);
  if (!cId) {
    showToast("Empresa não identificada.", "error");
    return;
  }

  try {
    await addDoc(collection(db, "commission_rules"), {
      companyId: cId,
      title: title,
      cycleStart: cycleStart,
      cycleEnd: cycleEnd,
      min: min,
      max: max,
      value: val,
      createdAt: serverTimestamp()
    });
    
    minInput.value = '';
    maxInput.value = '';
    valInput.value = '';
    
    if (window.loadCommissionRules) window.loadCommissionRules();
  } catch (e) {
    console.error("Erro ao salvar regra:", e);
    showToast("Erro ao salvar regra: " + e.message, "error");
  }
};

window.loadCommissionRules = async function() {
  const list = document.getElementById('commissionRulesList');
  if (!list) return;
  
  try {
    const q = query(collection(db, "commission_rules"), where("companyId", "==", window.companyId));
    const snapshot = await getDocs(q);
    
    list.innerHTML = '';
    if (snapshot.empty) {
      list.innerHTML = '<p style="text-align:center; padding:20px; font-size:11px; color:var(--pr-text-muted);">Nenhuma regra definida ainda.</p>';
      return;
    }

    let rules = [];
    snapshot.forEach(docSnap => rules.push({ id: docSnap.id, ...docSnap.data() }));
    rules.sort((a, b) => (a.min || 0) - (b.min || 0));

    rules.forEach(r => {
      const item = document.createElement('div');
      item.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:var(--pr-surface); padding:10px 15px; border-radius:10px; border:1px solid var(--pr-border);";
      item.innerHTML = `
        <div style="font-size:12px;">
          <div style="font-weight:800; color:var(--pr-text); margin-bottom: 2px;">${r.title || 'Regra'} <span style="font-size:9px; color:var(--pr-text-muted); font-weight:600;">(Ciclo: Dia ${r.cycleStart || 1} ao ${r.cycleEnd || 31})</span></div>
          <span style="font-weight:700; color:var(--pr-blue-mid);">${r.min}kg - ${r.max}kg</span>
          <span style="margin-left:10px; color:#27ae60; font-weight:800;">R$ ${Number(r.value).toFixed(2)}</span>
        </div>
        <button onclick="window.deleteCommissionRule('${r.id}')" style="background:none; border:none; color:#e74c3c; cursor:pointer; font-size:11px; font-weight:700; text-transform:uppercase;">Excluir</button>
      `;
      list.appendChild(item);
    });
  } catch (e) {
    console.error(e);
  }
};

window.deleteCommissionRule = async function(ruleId) {
  if (await window.showConfirm("Deseja excluir esta regra?", "Excluir Regra", "🗑️")) {
    try {
      await deleteDoc(doc(db, "commission_rules", ruleId));
      window.loadCommissionRules();
    } catch (e) {
      showToast("Erro ao excluir: " + e.message, "error");
    }
  }
};

window.openDriverRoutesModal = function() {
  document.getElementById('driverRoutesModal').classList.add('active');
};

window.closeDriverRoutesModal = function() {
  document.getElementById('driverRoutesModal').classList.remove('active');
};

// ══════════════════════════════════════════════════════════
// PERFIL DO USUÁRIO
// ══════════════════════════════════════════════════════════

window.openProfileModal = async function() {
  if (!currentUser) return;
  
  const modal = document.getElementById('profileModal');
  const nameInput = document.getElementById('profileName');
  const emailDisplay = document.getElementById('profileEmailDisplay');
  const circle = document.getElementById('profileInitialsCircle');
  
  if (modal) modal.classList.add('active');
  
  // Inicializa a sincronização
  window.syncProfileInitials();
  
  try {
    const userSnap = await getDoc(doc(db, "users", currentUser.uid));
    if (userSnap.exists()) {
      const u = userSnap.data();
      if (nameInput) nameInput.value = u.nome || "";
      if (emailDisplay) emailDisplay.textContent = currentUser.email;
      window.syncProfileInitials();
    } else {
      if (emailDisplay) emailDisplay.textContent = currentUser.email;
      window.syncProfileInitials();
    }
  } catch (e) {
    console.error("Erro ao abrir perfil:", e);
  }
};

window.closeProfileModal = function() {
  const modal = document.getElementById('profileModal');
  if (modal) modal.classList.remove('active');
};

window.updateProfileData = async function() {
  if (!currentUser) return;
  
  const nome = document.getElementById('profileName').value.trim();
  
  try {
    // Atualizar no Firestore
    await updateDoc(doc(db, "users", currentUser.uid), {
      nome: nome
    });

    // Atualizar cache global
    if (window.currentUserData) {
      window.currentUserData.nome = nome;
    }

    // Atualizar iniciais no topo
    const navAvatar = document.querySelector('.nav-avatar');
    if (navAvatar) {
      navAvatar.textContent = getInitials(nome || currentUser.email || 'A');
    }
    
    showToast("Perfil atualizado com sucesso!", "success");
    window.closeProfileModal();
  } catch (e) {
    showToast("Erro ao atualizar perfil: " + e.message, "error");
  }
};

// ══════════════════════════════════════════════════════════
// AUTENTICAÇÃO E CONFIGURAÇÃO DE ROLE
// ══════════════════════════════════════════════════════════

onAuthStateChanged(auth, async (user) => {
  if (!user) {
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
        window.userRole = "pending";
        window.adminId = null;
        await setDoc(userRef, {
          email: currentUser.email,
          nome: currentUser.displayName || '',
          role: "pending",
          companyId: null,
          createdAt: serverTimestamp()
        });
        udata = { role: "pending" };
      } else {
        udata = userSnap.data();
        window.userRole = udata.role || "pending";
        window.adminId = udata.adminId || null;

        // ── Auto-patch: corrige contas criadas ANTES do campo companyId existir ──
        if ((udata.role === 'admin' || udata.role === 'driver') && !udata.companyId) {
          const fixedCompanyId = udata.adminId || currentUser.uid;
          try {
            await setDoc(userRef, { companyId: fixedCompanyId }, { merge: true });
            udata.companyId = fixedCompanyId;
            console.log('[Auth] companyId migrado automaticamente:', fixedCompanyId);
          } catch(e) {
            console.warn('[Auth] Falha ao migrar companyId:', e.message);
          }
        }

        // companyId: admin usa o próprio UID; motorista usa o UID do seu admin
        window.companyId = udata.companyId || window.adminId || currentUser.uid;
        window.currentUserData = udata; // Cache global
        
        if (udata.inviteCodeCache) {
          document.getElementById('rpDriverInput').value = udata.inviteCodeCache;
        }
        
        // Atualiza iniciais no avatar da navegação
        const navAvatar = document.getElementById('navAvatar');
        if (navAvatar) {
          navAvatar.textContent = getInitials(udata.nome || currentUser.displayName || currentUser.email || 'A');
        }
      }

      // Logic moved to global window.hideLoader


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
              companyId: inviteData.adminId,  // isolamento multi-tenant
              inviteCodeCache: null
            });
            await updateDoc(inviteRef, { usado: true, usedBy: currentUser.uid });
            window.userRole = 'driver';
            window.adminId = inviteData.adminId;
            window.companyId = inviteData.adminId;

            // Limpar o ?convite= da URL sem recarregar
            window.history.replaceState({}, document.title, window.location.pathname);

            showToast(`Conta vinculada à frota com sucesso!`, 'success');
      applyRoleUI();
      window.hideLoader();
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
                  companyId: inviteData.adminId,  // isolamento multi-tenant
                  inviteCodeCache: null
                });
                await updateDoc(inviteRef, { usado: true, usedBy: currentUser.uid });
                window.userRole = 'driver';
                window.adminId = inviteData.adminId;
                window.companyId = inviteData.adminId;
                
                window.companyId = inviteData.adminId;
                
                showToast(`Conta vinculada à frota via Convite!`, 'success');
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
  if (await window.showConfirm("Gerar uma nova chave secreta gerencial?\nEsta chave poderá ser usada UMA vez.", "Nova Chave", "🔑")) {
    try {
      const code = 'ADM-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      await setDoc(doc(db, "admin_keys", code), {
        usado: false,
        createdBy: window.companyId || currentUser.uid,
        companyId: window.companyId || currentUser.uid,  // isolamento multi-tenant
        createdAt: serverTimestamp()
      });
      document.getElementById('adminInviteResult').style.display = 'block';
      document.getElementById('adminInviteKeyText').innerText = code;
      showToast("Chave gerada com sucesso!", "success");
    } catch (e) {
      console.error(e);
      showToast("Erro ao criar chave. Verifique suas permissões.", "error");
    }
  }
};

// Role Picker Submission (Post-Login)
window.submitRoleSelection = async function(role) {
  const UID = currentUser.uid;

  try {
    if (role === 'owner') {

      // Usar setDoc direto (sem batch) para evitar rejeição de rules em pending
      await setDoc(doc(db, "users", UID), {
        role: 'admin',
        inviteCodeCache: null,
        adminId: null,
        companyId: UID,
        email: currentUser.email || '',
        nome: currentUser.displayName || '',
        createdAt: serverTimestamp()
      }, { merge: true });

      window.userRole = 'admin';
      window.adminId = null;
      window.companyId = UID;

      document.getElementById('rolePickerModal').classList.remove('active');
      applyRoleUI();
      loadLocations();
      showToast("Frota criada com sucesso! Bem-vindo(a).", "success");
      return;

    } else if (role === 'admin') {
      const secretInput = document.getElementById('rpAdminInput').value.trim().toUpperCase();
      if (!secretInput) {
        showToast("Preencha a chave secreta!", "warning");
        return;
      }

      const keyRef = doc(db, "admin_keys", secretInput);
      const keySnap = await getDoc(keyRef);
      if (!keySnap.exists()) {
        showToast("Chave inexistente!", "error");
        return;
      }
      if (keySnap.data().usado) {
        showToast("Esta chave já foi usada!", "warning");
        return;
      }

      const originalAdminUid = keySnap.data().createdBy;
      const isSystemKey = originalAdminUid === 'SYSTEM_SETUP';
      const coAdminCompanyId = isSystemKey ? UID : originalAdminUid;

      // Atualizar chave primeiro (operação permitida para qualquer autenticado)
      await updateDoc(keyRef, { usado: true, usedBy: UID });

      // Depois promover o usuário
      await setDoc(doc(db, "users", UID), {
        role: 'admin',
        adminKey: secretInput,
        inviteCodeCache: null,
        adminId: isSystemKey ? null : originalAdminUid,
        companyId: coAdminCompanyId
      }, { merge: true });

      // Deletar a chave — sem rastros
      try { await deleteDoc(keyRef); } catch(e) { /* silencioso */ }

      window.userRole = 'admin';
      window.adminId = isSystemKey ? null : originalAdminUid;
      window.companyId = coAdminCompanyId;

    } else if (role === 'driver') {
      let rawInput = document.getElementById('rpDriverInput').value.trim();
      if (!rawInput) {
        showToast("Cole o link de convite recebido.", "warning");
        return;
      }

      let inviteCode = rawInput;
      try {
        if (rawInput.includes('convite=')) {
          const url = new URL(rawInput);
          inviteCode = url.searchParams.get('convite') || rawInput;
        }
      } catch(e) {
        const match = rawInput.match(/convite=([a-zA-Z0-9\-]+)/);
        if (match) inviteCode = match[1];
      }

      const inviteRef = doc(db, "invites", inviteCode);
      const inviteSnap = await getDoc(inviteRef);
      if (!inviteSnap.exists()) {
        showToast("Código de convite inválido.", "error");
        return;
      }

      const inviteData = inviteSnap.data();
      if (inviteData.usado) {
        showToast("Este convite já foi utilizado.", "warning");
        return;
      }

      await updateDoc(doc(db, "users", UID), {
        role: 'driver',
        adminId: inviteData.adminId,
        companyId: inviteData.adminId,
        inviteCodeCache: null
      });
      await updateDoc(inviteRef, { usado: true, usedBy: UID });

      window.userRole = 'driver';
      window.adminId = inviteData.adminId;
      window.companyId = inviteData.adminId;
    }

    document.getElementById('rolePickerModal').classList.remove('active');
    applyRoleUI();
    loadLocations();
    showToast("Perfil configurado com sucesso!", "success");

  } catch(e) {
    console.error("Erro ao configurar perfil:", e);
    showToast("Erro na configuração: " + e.message, "error");
  }
}

window.handleLogout = async function() {
  if(await window.showConfirm("Deseja realmente sair?", "Sair da Conta", "🚪")) {
    try {
      if(document.getElementById('rpAdminInput')) document.getElementById('rpAdminInput').value = '';
      if(document.getElementById('rpDriverInput')) document.getElementById('rpDriverInput').value = '';
      if (driverMissionsUnsubscribe) {
        driverMissionsUnsubscribe();
        driverMissionsUnsubscribe = null;
      }
      await signOut(auth);
    } catch(e) {
      showToast("Erro ao sair: " + e.message, "error");
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
  if(await window.showConfirm("Tem certeza que deseja excluir este local?", "Excluir Local", "📍")) {
    try {
      await deleteDoc(doc(db, "users", currentUser.uid, "locations", id));
    } catch(e) {
      showToast("Erro ao excluir: " + e.message, "error");
    }
  }
};

window.saveLocation = async function() {
  if (!currentUser) return;
  const linkInput = document.getElementById('locInput').value.trim();
  let nameInput = document.getElementById('locNameInput').value.trim();
  const editId = document.getElementById('locEditingId').value;
  
  if(!linkInput) return showToast("Por favor, digite um link ou endereço.", "warning");

  // Validação básica do input
  if(linkInput.length < 3) return showToast("O endereço ou link parece muito curto.", "warning");

  const btn = document.getElementById('locSaveBtn');
  btn.textContent = 'Aguarde...';
  btn.style.pointerEvents = 'none';

  let resolvedData = { lat: null, lng: null, expandedUrl: "", name: nameInput || "Local Adicionado" };

  // Tentar extração client-side imediata se for link
  if (linkInput.includes('http')) {
    const clientCoords = window.extractCoordsFromUrl(linkInput);
    if (clientCoords) {
      resolvedData.lat = clientCoords.lat;
      resolvedData.lng = clientCoords.lng;
    }
  }

  // Tentar resolver via backend
  try {
    const idToken = await auth.currentUser.getIdToken();
    const res = await fetch(`${CONFIG.apiUrl}/api/resolve`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ url: linkInput })
    });
    
    if(res.ok) {
      const data = await res.json();
      resolvedData = {
        lat: (data.lat !== undefined && data.lat !== null) ? data.lat : resolvedData.lat,
        lng: (data.lng !== undefined && data.lng !== null) ? data.lng : resolvedData.lng,
        expandedUrl: data.expandedUrl || "",
        name: nameInput || data.name || "Local Adicionado"
      };
    }
  } catch(e) {
    console.warn("Backend offline ou erro na resolução.", e.message);
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
    showToast("Falha ao salvar local. Detalhes: " + e.message, "error");
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
        const apiKey = CONFIG.firebase.apiKey;
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
  
  // Reset stages
  window.showRouteSetupStage();
  
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

window.showDriverSelectionStage = function() {
  if (builderSelectedPoints.length === 0) {
    return showToast("Adicione pelo menos um local à rota antes de escolher o motorista.", "error");
  }
  
  const stage1 = document.getElementById('builderStage1');
  const stage2 = document.getElementById('builderStage2');
  if (stage1 && stage2) {
    stage1.style.display = 'none';
    stage2.style.display = 'flex';
  }
  
  if (window.filterBuilderDrivers) window.filterBuilderDrivers();
};

window.showRouteSetupStage = function() {
  const stage1 = document.getElementById('builderStage1');
  const stage2 = document.getElementById('builderStage2');
  if (stage1 && stage2) {
    stage1.style.display = 'flex';
    stage2.style.display = 'none';
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
    genBtn.textContent = `Enviar para ${driverName}`;
    genBtn.style.background = '#27ae60';
  } else {
    genBtn.textContent = 'Salvar Rota';
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
  const term = document.getElementById('builderSearch').value.trim();
  const lowerTerm = term.toLowerCase();
  container.innerHTML = '';
  
  // Opção para adicionar input bruto se for link ou endereço longo
  if (term.length > 5) {
     const rawItem = document.createElement('div');
     rawItem.className = 'loc-item';
     rawItem.style.background = 'rgba(26,107,175,0.05)';
     rawItem.style.border = '1px dashed var(--pr-blue-mid)';
     rawItem.style.marginBottom = '6px';
     rawItem.innerHTML = `
       <div class="loc-dot dot-b" style="background:var(--pr-blue-mid); cursor:pointer;" onclick="window.addRawRoutePoint()">＋</div>
       <div class="loc-info" style="cursor:pointer;" onclick="window.addRawRoutePoint()">
         <div class="loc-name" style="color:var(--pr-blue-dark); font-weight:700;">Adicionar: "${escapeHTML(term.substring(0, 30))}${term.length > 30 ? '...' : ''}"</div>
         <div class="loc-addr" style="font-size:9px;">Adicionar como nova parada direta</div>
       </div>
     `;
     container.appendChild(rawItem);
  }

  const filtered = allLocations.filter(loc => 
    (loc.name||'').toLowerCase().includes(lowerTerm) || 
    (loc.originalInput||'').toLowerCase().includes(lowerTerm)
  );

  filtered.forEach(loc => {
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
  
  if (filtered.length === 0 && term.length <= 5) {
    container.innerHTML = `<div style="padding:10px;font-size:11px;color:var(--pr-text-muted);text-align:center;">Busque ou cole um link para adicionar.</div>`;
  }
};

window.addRawRoutePoint = async function() {
  const term = document.getElementById('builderSearch').value.trim();
  if (!term) return;

  const btn = document.querySelector('.loc-dot.dot-b');
  const originalText = btn ? btn.textContent : '＋';
  if (btn) btn.textContent = '⏳';

  const newPoint = {
    id: 'raw-' + Date.now(),
    name: term.includes('http') ? 'Local via Link' : term,
    originalInput: term,
    lat: null, 
    lng: null
  };

  // 1. Tenta extração local imediata
  const clientCoords = window.extractCoordsFromUrl(term);
  if (clientCoords) {
    newPoint.lat = clientCoords.lat;
    newPoint.lng = clientCoords.lng;
  }

  // 2. Se for link e não pegou coords, tenta o backend (Senior resolution)
  if (term.includes('http') && (!newPoint.lat || !newPoint.lng)) {
    try {
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch(`${CONFIG.apiUrl}/api/resolve`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ url: term })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.lat && data.lng) {
          newPoint.lat = data.lat;
          newPoint.lng = data.lng;
          if (data.name) newPoint.name = data.name;
        }
      }
    } catch (e) {
      console.warn("Falha ao resolver link em tempo real no builder", e);
    }
  }

  builderSelectedPoints.push(newPoint);
  document.getElementById('builderSearch').value = '';
  if (btn) btn.textContent = originalText;
  
  renderBuilderSequence();
  renderBuilderLocations();
  showToast("Parada adicionada diretamente.", "success");
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

/* ══════════════════════════════════════════════════════════
   DRAG AND DROP - ADMIN ROUTE BUILDER
   ══════════════════════════════════════════════════════════ */
let draggedBuilderItemIndex = null;

window.handleBuilderDragStart = function(e, index) {
  if (isTouchDevice()) return; // Previne DnD em touch para permitir scroll
  draggedBuilderItemIndex = index;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', index);
};

window.handleBuilderDragOver = function(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
};

window.handleBuilderDrop = function(e, targetIndex) {
  e.preventDefault();
  if (draggedBuilderItemIndex === null || draggedBuilderItemIndex === targetIndex) return;
  
  const item = builderSelectedPoints.splice(draggedBuilderItemIndex, 1)[0];
  builderSelectedPoints.splice(targetIndex, 0, item);
  
  draggedBuilderItemIndex = null;
  renderBuilderSequence();
};

window.handleBuilderDragEnd = function(e) {
  e.currentTarget.classList.remove('dragging');
  draggedBuilderItemIndex = null;
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
  if(!container) return;

  if(builderSelectedPoints.length === 0) {
    container.innerHTML = `<div style="font-size:11px; color:var(--pr-text-muted); text-align:center; padding:20px 10px; border:1px dashed var(--pr-border); border-radius:10px;">Nenhum ponto adicionado ainda. Pesquise e selecione locais acima.</div>`;
    return;
  }
  
  container.innerHTML = '';
  builderSelectedPoints.forEach((loc, i) => {
    const item = document.createElement('div');
    item.className = 'route-sequence-item';
    
    // Configura Drag and Drop
    item.draggable = !isTouchDevice();
    item.setAttribute('ondragstart', `handleBuilderDragStart(event, ${i})`);
    item.setAttribute('ondragover', `handleBuilderDragOver(event)`);
    item.setAttribute('ondrop', `handleBuilderDrop(event, ${i})`);
    item.setAttribute('ondragend', `handleBuilderDragEnd(event)`);

    item.innerHTML = `
      <div class="drag-handle" title="Arraste para reordenar">⠿</div>
      <div class="badge">${i + 1}</div>
      <div class="name" title="${escapeHTML(loc.name || loc.originalInput)}">
        ${escapeHTML(loc.name || loc.originalInput)}
      </div>
      <div class="sequence-actions">
        <div class="move-btns">
          <button class="move-btn" onclick="moveRoutePoint(${i}, -1)" ${i === 0 ? 'disabled' : ''} title="Subir">▲</button>
          <button class="move-btn" onclick="moveRoutePoint(${i}, 1)" ${i === builderSelectedPoints.length - 1 ? 'disabled' : ''} title="Descer">▼</button>
        </div>
        <button class="remove-point-btn" onclick="removeRoutePoint(${i})" title="Remover este ponto">
          ✕
        </button>
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
      showToast("Aguarde a autenticação ou faça login novamente.", "warning");
      resetBtn();
      return;
    }

    if(builderSelectedPoints.length < 1) {
      showToast("Selecione pelo menos 1 ponto para a rota.", "warning");
      resetBtn();
      return;
    }
    
    // 1) Montar o link do Google Maps (SEM abrir)
    const lastP = builderSelectedPoints[builderSelectedPoints.length - 1];
    let mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${window.formatMapsLocation(lastP)}&travelmode=driving`;
    if (builderSelectedPoints.length > 1) {
      const wpUrls = builderSelectedPoints.slice(0, -1).map(p => window.formatMapsLocation(p));
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

    // 3) Preparar dados da rota (Peso e Valor removidos a pedido do usuário)

    const routeData = {
      points: builderSelectedPoints.map(p => ({
        name: p.name, 
        input: p.originalInput, 
        lat: (p.lat !== null && p.lat !== undefined) ? Number(p.lat) : null, 
        lng: (p.lng !== null && p.lng !== undefined) ? Number(p.lng) : null
      })),
      distance: "—", time: "—", stopsCount: builderSelectedPoints.length, 
      polyline: "",
      mapsUrl: mapsUrl,
      status: "Pendente",
      expectedWeight: 0,
      expectedValue: 0,
      createdAt: serverTimestamp()
    };

    // Se está enviando para um motorista, salvar quem enviou
    if (targetUid !== currentUser.uid) {
      routeData.assignedBy = currentUser.uid;
      const u = window.currentUserData || {};
      routeData.assignedByName = u.nome || currentUser.displayName || currentUser.email || 'Admin';
    }

    // 4) Salvar no banco usando Batch para consistência e performance
    const batch = writeBatch(db);
    const newRouteRef = doc(collection(db, "users", targetUid, "history"));
    batch.set(newRouteRef, routeData);

    // Denormalização: Salva o resumo no documento do motorista para o Monitoramento Admin
    batch.update(doc(db, "users", targetUid), {
      lastRouteSummary: {
        id: newRouteRef.id,
        status: routeData.status,
        stopsCount: routeData.stopsCount,
        expectedWeight: routeData.expectedWeight,
        expectedValue: routeData.expectedValue,
        assignedByName: routeData.assignedByName || null,
        createdAt: serverTimestamp()
      }
    });

    await batch.commit();

    // 5) Feedback visual + fechar modal
    window.currentRouteUrl = mapsUrl;
    if(genBtn) genBtn.textContent = "✅ Enviado!";
    const builderModal = document.getElementById('builderModal');
    if(builderModal) builderModal.classList.remove('active');

    if (targetDriverName) {
      showToast(`Rota enviada para ${targetDriverName} (${builderSelectedPoints.length} paradas)`, 'success');
    }

    // 4) [REMOVIDO] Deduzir peso e valor da meta mensal (agora é deduzido apenas na finalização pelo motorista)
    // Os valores expectedWeight e expectedValue vão para a "Carga Programada" apenas.

    // 5) Tentar calcular detalhes e trajeto em BACKGROUND via OSRM
    window.calculateOSRMBackground(newRouteRef, builderSelectedPoints);

    // Reset do botão em background
    setTimeout(resetBtn, 1500);

  } catch (err) {
    console.error("Erro ao salvar rota:", err);
    showToast("Erro ao salvar a rota: " + err.message, "error");
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
    showToast("Nenhuma rota ativa no momento!", "warning");
  }
};

// Card click handler — abre fleet panel (admin) ou rota (driver)
window.handleDailyCardClick = function() {
  if (window.userRole === 'admin') {
    window.openFleetPanel();
  } else {
    if (!window.activeRouteData) {
      showToast("Nenhuma rota ativa no momento!", "warning");
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

/* ══════════════════════════════════════════════════════════
   DRAG AND DROP - DRIVER DAILY ROUTE
   ══════════════════════════════════════════════════════════ */
let draggedDailyItemIndex = null;

window.handleDailyDragStart = function(e, index) {
  if (isTouchDevice()) return;
  draggedDailyItemIndex = index;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', index);
};

window.handleDailyDragOver = function(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
};

window.handleDailyDrop = function(e, targetIndex) {
  e.preventDefault();
  if (draggedDailyItemIndex === null || draggedDailyItemIndex === targetIndex) return;
  
  const item = window.tempDriverRouteSequence.splice(draggedDailyItemIndex, 1)[0];
  window.tempDriverRouteSequence.splice(targetIndex, 0, item);
  
  draggedDailyItemIndex = null;
  window.renderDriverDailyRoutePoints();
};

window.handleDailyDragEnd = function(e) {
  e.currentTarget.classList.remove('dragging');
  draggedDailyItemIndex = null;
};

window.moveDailyRoutePoint = function(index, direction) {
  if (direction === -1 && index > 0) {
    const temp = window.tempDriverRouteSequence[index];
    window.tempDriverRouteSequence[index] = window.tempDriverRouteSequence[index - 1];
    window.tempDriverRouteSequence[index - 1] = temp;
  } else if (direction === 1 && index < window.tempDriverRouteSequence.length - 1) {
    const temp = window.tempDriverRouteSequence[index];
    window.tempDriverRouteSequence[index] = window.tempDriverRouteSequence[index + 1];
    window.tempDriverRouteSequence[index + 1] = temp;
  }
  window.renderDriverDailyRoutePoints();
};

window.removeDailyRoutePoint = function(index) {
  if (window.tempDriverRouteSequence.length <= 1) {
    showToast("A rota deve ter pelo menos um ponto.", "warning");
    return;
  }
  window.tempDriverRouteSequence.splice(index, 1);
  window.renderDriverDailyRoutePoints();
};

window.renderDriverDailyRoutePoints = function() {
  const container = document.getElementById('driverDailyRoutePoints');
  if (!container) return;
  container.innerHTML = "";
  
  const points = window.tempDriverRouteSequence;
  
  if (points.length === 0) {
    container.innerHTML = `<div style="font-size:11px; color:var(--pr-text-muted); text-align:center; padding:20px 10px;">Nenhuma parada nesta rota.</div>`;
    return;
  }

  points.forEach((pt, i) => {
    const item = document.createElement('div');
    item.className = 'route-sequence-item';
    
    // Configura Drag and Drop (igual ao builder)
    item.draggable = !isTouchDevice();
    item.setAttribute('ondragstart', `handleDailyDragStart(event, ${i})`);
    item.setAttribute('ondragover', `handleDailyDragOver(event)`);
    item.setAttribute('ondrop', `handleDailyDrop(event, ${i})`);
    item.setAttribute('ondragend', `handleDailyDragEnd(event)`);

    const displayName = pt.name || pt.address || "Local sem nome";

    item.innerHTML = `
      <div class="drag-handle" title="Arraste para reordenar">⠿</div>
      <div class="badge">${i + 1}</div>
      <div class="name" title="${escapeHTML(displayName)}">
        ${escapeHTML(displayName)}
      </div>
      <div class="sequence-actions">
        <div class="move-btns">
          <button class="move-btn" onclick="moveDailyRoutePoint(${i}, -1)" ${i === 0 ? 'disabled' : ''} title="Subir">▲</button>
          <button class="move-btn" onclick="moveDailyRoutePoint(${i}, 1)" ${i === points.length - 1 ? 'disabled' : ''} title="Descer">▼</button>
        </div>
        <button class="remove-point-btn" onclick="removeDailyRoutePoint(${i})" title="Remover este ponto">
          ✕
        </button>
      </div>
    `;
    container.appendChild(item);
  });
};

window.startDriverDailyRoute = function() {
  if (!window.activeRouteId) {
    showToast("Erro: ID da rota não encontrado.", "error");
    return;
  }
  if (!window.tempDriverRouteSequence || window.tempDriverRouteSequence.length === 0) {
    showToast("Nenhum ponto selecionado para rotear.", "warning");
    return;
  }

  // 1. Generate Maps URL based on tempDriverRouteSequence
  let mapsUrl = `https://www.google.com/maps/dir/?api=1`;
  
  const lastP = window.tempDriverRouteSequence[window.tempDriverRouteSequence.length - 1];
  const wpUrls = window.tempDriverRouteSequence.slice(0, -1).map(p => window.formatMapsLocation(p));
  
  mapsUrl += `&destination=${window.formatMapsLocation(lastP)}&travelmode=driving`;
  if (wpUrls.length > 0) {
    mapsUrl += `&waypoints=${wpUrls.join('%7C')}`;
  }


  // 2. Mark route as "Em Rota" in Firestore and sync with Admin
  window.updateRouteStatus(window.activeRouteId, "Em Rota").catch(e => console.warn("Falha ao sincronizar status", e));

  // 3. Open URL
  // Sênior Fix: No mobile, usamos window.location.href para disparar o "Intent" do aplicativo nativo.
  // Usar '_blank' força o sistema a abrir o navegador (Chrome/Safari) em vez de sugerir o App Google Maps.
  if (isTouchDevice()) {
    window.location.href = mapsUrl;
  } else {
    window.open(mapsUrl, '_blank');
  }

  // 4. Reset UI state without a hard reload that could cancel the navigation intent
  setTimeout(() => {
    closeDriverDailyRouteModal();
    // Opcional: Se quiser resetar algum estado específico, faça aqui em vez de reload()
  }, 500);
};

// ══════════════════════════════════════════════════════════
// FLEET PANEL — Painel flutuante de motoristas
// ══════════════════════════════════════════════════════════

window.openFleetPanel = function() {
  const panel = document.getElementById('fleetPanel');
  const card = document.getElementById('dailyRouteCard');
  const badge = document.getElementById('pdRouteDetails');
  const pill = document.getElementById('mapStatsPill');
  
  // Garantir que outros paineis exclusivos fechem
  if (window.closeGoalsDashboard) window.closeGoalsDashboard();

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

      const displayName = u.nome || 'Sem nome';
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
          <div style="font-size:36px; margin-bottom:12px;">🚚</div>
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
  const term = (document.getElementById('schedLocSearch').value || '').trim();
  const lowerTerm = term.toLowerCase();
  container.innerHTML = '';

  // Opção para adicionar input bruto no agendamento
  if (term.length > 5) {
     const rawItem = document.createElement('div');
     rawItem.className = 'loc-item';
     rawItem.style.cssText = 'background:rgba(26,107,175,0.05); border:1px dashed var(--pr-blue-mid); margin-bottom:6px; padding:6px 10px;';
     rawItem.innerHTML = `
       <div class="loc-dot dot-b" style="background:var(--pr-blue-mid); cursor:pointer;" onclick="window.fpAddRawSchedPoint()">＋</div>
       <div class="loc-info" style="cursor:pointer;" onclick="window.fpAddRawSchedPoint()">
         <div class="loc-name" style="color:var(--pr-blue-dark); font-weight:700;">Adicionar: "${escapeHTML(term.substring(0, 30))}"</div>
         <div class="loc-addr" style="font-size:9px;">Parada direta via link ou endereço</div>
       </div>
     `;
     container.appendChild(rawItem);
  }

  const filtered = allLocations.filter(loc =>
    (loc.name || '').toLowerCase().includes(lowerTerm) ||
    (loc.originalInput || '').toLowerCase().includes(lowerTerm)
  );

  filtered.forEach(loc => {
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
  
  if (filtered.length === 0 && term.length <= 5) {
    container.innerHTML = '<div style="padding:10px; font-size:11px; color:var(--pr-text-muted); text-align:center;">Nenhum local encontrado.</div>';
  }
}

window.fpAddRawSchedPoint = function() {
  const term = document.getElementById('schedLocSearch').value.trim();
  if (!term) return;
  const newPoint = {
    id: 'raw-' + Date.now(),
    name: term.includes('http') ? 'Local via Link' : term,
    originalInput: term,
    lat: null, lng: null
  };
  const coords = window.extractCoordsFromUrl(term);
  if (coords) {
    newPoint.lat = coords.lat;
    newPoint.lng = coords.lng;
  }
  window._fpSchedulePoints.push(newPoint);
  document.getElementById('schedLocSearch').value = '';
  fpRenderScheduleSequence();
  fpRenderScheduleLocations();
};

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
  if (!driverUid) return showToast("Nenhum motorista selecionado.", "error");

  const dateVal = document.getElementById('schedDate').value;
  const timeVal = document.getElementById('schedTime').value;
  const note = document.getElementById('schedNote').value.trim();

  if (!dateVal) return showToast("Selecione uma data para o envio.", "error");
  if (window._fpSchedulePoints.length < 1) return showToast("Adicione pelo menos 1 ponto à rota.", "error");

  const btn = document.getElementById('schedSaveBtn');
  btn.textContent = '⏳ Salvando...';
  btn.style.pointerEvents = 'none';
  btn.style.opacity = '0.7';

  try {
    // Montar timestamp do agendamento
    const [year, month, day] = dateVal.split('-').map(Number);
    const [hour, minute] = timeVal.split(':').map(Number);
    const scheduledDate = new Date(year, month - 1, day, hour, minute);

    // Montar o link do Google Maps
    const lastP = window._fpSchedulePoints[window._fpSchedulePoints.length - 1];
    let mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${window.formatMapsLocation(lastP)}&travelmode=driving`;
    if (window._fpSchedulePoints.length > 1) {
      const wpUrls = window._fpSchedulePoints.slice(0, -1).map(p => window.formatMapsLocation(p));
      mapsUrl += `&waypoints=${wpUrls.join('%7C')}`;
    }

    // Salvar na subcollection do motorista
    await addDoc(collection(db, "users", driverUid, "scheduledRoutes"), {
      points: window._fpSchedulePoints.map(p => ({ 
        name: p.name, 
        input: p.originalInput, 
        lat: (p.lat !== null && p.lat !== undefined) ? Number(p.lat) : null, 
        lng: (p.lng !== null && p.lng !== undefined) ? Number(p.lng) : null 
      })),
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
    showToast("Erro ao agendar rota: " + e.message, "error");
    btn.textContent = '📅 Agendar Rota';
    btn.style.pointerEvents = 'auto';
    btn.style.opacity = '1';
  }
};

// Enviar rota agendada imediatamente (mover para history)
window.fpSendScheduledNow = async function(schedId) {
  const driverUid = window._fpCurrentDriverUid;
  if (!driverUid) return;

  if (!(await window.showConfirm("Deseja enviar essa rota agora para o motorista?", "Enviar Rota", "🚚"))) return;

  try {
    const schedRef = doc(db, "users", driverUid, "scheduledRoutes", schedId);
    const schedSnap = await getDoc(schedRef);
    if (!schedSnap.exists() || schedSnap.data().status !== "scheduled") return showToast("Rota agendada já enviada ou não encontrada.", "error");

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
      assignedByName: (window.currentUserData?.nome || currentUser.displayName || currentUser.email || 'Admin')
    };

    if (data.note) routeData.note = data.note;


    const newRouteRef = await addDoc(collection(db, "users", driverUid, "history"), routeData);
    
    // Tentar calcular detalhes e trajeto em BACKGROUND via OSRM
    window.calculateOSRMBackground(newRouteRef, routeData.points);

    showToast("✅ Rota enviada com sucesso para " + window._fpCurrentDriverName + "!", "success");
  } catch(e) {
    console.error("Erro ao enviar rota:", e);
    showToast("Erro ao enviar: " + e.message, "error");
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
        assignedByName: (window.currentUserData?.nome || currentUser.displayName || currentUser.email || 'Admin')
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
          assignedByName: (window.currentUserData?.nome || currentUser.displayName || currentUser.email || 'Admin')
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

  if (!(await window.showConfirm("Deseja excluir esta rota agendada?", "Excluir Agendamento", "🗑️"))) return;

  try {
    await deleteDoc(doc(db, "users", driverUid, "scheduledRoutes", schedId));
  } catch(e) {
    showToast("Erro ao excluir: " + e.message, "error");
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
    if (!schedSnap.exists()) return showToast("Agendamento não encontrado.", "error");

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
    showToast("Erro ao abrir agendamento: " + e.message, "error");
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
  const term = (document.getElementById('editSchedSearch').value || '').trim();
  const lowerTerm = term.toLowerCase();
  container.innerHTML = '';

  // Opção para adicionar input bruto na edição
  if (term.length > 5) {
     const rawItem = document.createElement('div');
     rawItem.className = 'loc-item';
     rawItem.style.cssText = 'background:rgba(26,107,175,0.05); border:1px dashed var(--pr-blue-mid); margin-bottom:6px; padding:6px 10px; cursor:pointer;';
     rawItem.onclick = () => window.fpAddRawEditPoint();
     rawItem.innerHTML = `
       <div class="loc-dot dot-b" style="background:var(--pr-blue-mid);">＋</div>
       <div class="loc-info">
         <div class="loc-name" style="color:var(--pr-blue-dark); font-weight:700;">Adicionar: "${escapeHTML(term.substring(0, 30))}"</div>
         <div class="loc-addr" style="font-size:9px;">Parada direta via link ou endereço</div>
       </div>
     `;
     container.appendChild(rawItem);
  }

  const filtered = allLocations.filter(loc =>
    (loc.name || '').toLowerCase().includes(lowerTerm) ||
    (loc.originalInput || '').toLowerCase().includes(lowerTerm)
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

  if (filtered.length === 0 && term.length <= 5) {
    container.innerHTML = '<div style="padding:8px; font-size:10px; color:var(--pr-text-muted); text-align:center;">Nenhum local encontrado.</div>';
  }
}

window.fpAddRawEditPoint = function() {
  const term = document.getElementById('editSchedSearch').value.trim();
  if (!term) return;
  const newPoint = {
    id: 'raw-' + Date.now(),
    name: term.includes('http') ? 'Local via Link' : term,
    originalInput: term,
    lat: null, lng: null
  };
  const coords = window.extractCoordsFromUrl(term);
  if (coords) {
    newPoint.lat = coords.lat;
    newPoint.lng = coords.lng;
  }
  window._editSchedPoints.push(newPoint);
  document.getElementById('editSchedSearch').value = '';
  fpRenderEditSchedStops();
  fpRenderEditSchedAvailable();
};

window.fpFilterEditSchedLocations = function() {
  fpRenderEditSchedAvailable();
};

window.fpSaveEditSchedule = async function() {
  if (window._editSchedPoints.length < 1) return showToast("Adicione pelo menos 1 parada.", "error");

  const btn = document.getElementById('editSchedSaveBtn');
  btn.textContent = '⏳ Salvando...';
  btn.style.pointerEvents = 'none';

  try {
    const lastP = window._editSchedPoints[window._editSchedPoints.length - 1];
    let mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${window.formatMapsLocation(lastP)}&travelmode=driving`;
    if (window._editSchedPoints.length > 1) {
      const wpUrls = window._editSchedPoints.slice(0, -1).map(p => window.formatMapsLocation(p));
      mapsUrl += `&waypoints=${wpUrls.join('%7C')}`;
    }

    const schedRef = doc(db, "users", window._editSchedDriverUid, "scheduledRoutes", window._editSchedId);
    await updateDoc(schedRef, {
      points: window._editSchedPoints.map(p => ({ 
        name: p.name, 
        input: p.originalInput, 
        lat: (p.lat !== null && p.lat !== undefined) ? Number(p.lat) : null, 
        lng: (p.lng !== null && p.lng !== undefined) ? Number(p.lng) : null 
      })),
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
    showToast("Erro ao salvar: " + e.message, "error");
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
      companyId: window.companyId,  // isolamento multi-tenant
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
    showToast("Erro ao gerar convite: " + e.message, "error");
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
      const displayName = u.nome || 'Sem nome';
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
          <label style="font-size:10px; font-weight:700; color:var(--pr-text-muted); white-space:nowrap;">Nome Completo:</label>
          <input type="text" value="${escapeHTML(u.nome || '')}" placeholder="Ex: João da Silva" 
            style="flex:1; border:1px solid var(--pr-border); border-radius:6px; padding:5px 8px; font-size:11px; background:var(--pr-bg); color:var(--pr-text); outline:none;"
            id="name_${uid}" />
          <button onclick="event.stopPropagation(); window.saveDriverName('${uid}', this)" 
            style="border:none; background:#1A6BAF; color:#fff; border-radius:6px; padding:5px 12px; font-size:10px; font-weight:700; cursor:pointer; white-space:nowrap;">Salvar</button>
        </div>
      `;
      
      list.appendChild(card);
    });
  } catch(e) {
    list.innerHTML = `<p style="text-align:center; color:red; font-size:12px;">Erro ao carregar: ${e.message}</p>`;
  }
}

window.saveDriverName = async function(driverUid, btn) {
  const input = document.getElementById('name_' + driverUid);
  const nameEl = document.getElementById('fleet_name_' + driverUid);
  const avatarEl = document.getElementById('fleet_avatar_' + driverUid);
  if (!input) return;
  const novoNome = input.value.trim();
  
  if (!novoNome) return showToast("O nome não pode ser vazio.", "error");

  btn.textContent = '...';
  btn.style.pointerEvents = 'none';
  try {
    await updateDoc(doc(db, "users", driverUid), { nome: novoNome });
    
    // Instantly update visual state in the DOM
    if (nameEl) nameEl.textContent = novoNome;
    if (avatarEl) avatarEl.textContent = novoNome.charAt(0).toUpperCase();

    btn.textContent = '✅';
    btn.style.background = '#27ae60';
    setTimeout(() => {
      btn.textContent = 'Salvar';
      btn.style.background = '#1A6BAF';
      btn.style.pointerEvents = 'auto';
    }, 2000);

    // 2. Update in-memory _fleetDrivers cache so the builder list stays in sync
    if (window._fleetDrivers) {
      const cached = window._fleetDrivers.find(d => d.uid === driverUid);
      if (cached) cached.nome = novoNome;
    }

    // 3. If the Fleet Panel (Rotas Futuras) is currently open, re-render it
    const fleetPanelEl = document.getElementById('fleetPanel');
    if (fleetPanelEl && fleetPanelEl.style.display !== 'none') {
      renderFleetDriverCards();
    }

    // 4. If Monitor (Visualizar Motoristas) is open, refresh driver pills/markers immediately
    const liveSpyModalEl = document.getElementById('liveSpyModal');
    if (liveSpyModalEl && liveSpyModalEl.classList.contains('active') && window._spyRefresh) {
      window._spyRefresh();
    }

    // NOTE: Admin Hub (Monitorar ao Vivo) auto-updates via its existing onSnapshot.
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
    console.warn('Erro ao salvar nome:', e);
  }
};

// PAINEL DA FROTA P/ ADMIN (Frota ao Vivo)
window.openAdminHub = function() {
  if (!checkRole('admin')) return;
  document.getElementById('adminHubModal').classList.add('active');
  loadAdminHubData();
};

window.renameDriver = async function(driverUid, oldName) {
  if (!checkRole('admin')) return;
  const newName = prompt(`Alterar nome para "${oldName}":`, oldName);
  if (newName === null) return;
  
  try {
    const trimmedName = newName.trim();
    if (!trimmedName) return showToast("O nome não pode ser vazio.", "error");
    await updateDoc(doc(db, "users", driverUid), { nome: trimmedName });

    // 1. Update in-memory _fleetDrivers cache
    if (window._fleetDrivers) {
      const cached = window._fleetDrivers.find(d => d.uid === driverUid);
      if (cached) cached.nome = trimmedName;
    }

    // 2. If the Fleet Panel (Rotas Futuras) is currently open, re-render it
    const fleetPanel = document.getElementById('fleetPanel');
    if (fleetPanel && fleetPanel.style.display !== 'none') {
      renderFleetDriverCards();
    }

    // 3. If Monitor (Visualizar Motoristas) is open, refresh driver pills/markers immediately
    const liveSpyEl = document.getElementById('liveSpyModal');
    if (liveSpyEl && liveSpyEl.classList.contains('active') && window._spyRefresh) {
      window._spyRefresh();
    }

    // NOTE: Admin Hub (Monitorar ao Vivo) auto-updates via its existing onSnapshot.
    showToast("Nome atualizado com sucesso!", "success");
  } catch(e) {
    showToast("Erro ao atualizar nome: " + e.message, "error");
  }
};

window.deleteDriver = async function(driverUid, name) {
  if (!checkRole('admin')) return;
  
  const confirm1 = await window.showConfirm(`🚨 ATENÇÃO: Você está prestes a EXCLUIR permanentemente o perfil de "${name}" do sistema.\n\nEsta ação removerá o acesso dele e seus dados de cadastro. Deseja continuar?`, "Exclusão Crítica", "🚨");
  if (!confirm1) return;
  
  const confirm2 = await window.showConfirm(`⚠️ Confirmação Final: Confirmar exclusão definitiva de "${name}"?`, "Confirmação Final", "⚠️");
  if (!confirm2) return;
  
  try {
    // Nota: Subcoleções como history e scheduledRoutes permanecerão no banco (lixo órfão), 
    // mas o usuário deixará de existir no sistema e sumirá do painel.
    await deleteDoc(doc(db, "users", driverUid));

    // Limpa a localização no Realtime Database para não gerar "fantasmas" no mapa
    const adminKey = window.companyId || (currentUser ? currentUser.uid : null);
    if (adminKey) {
      await rtdbRemove(rtdbRef(rtdb, `locations/${adminKey}/${driverUid}`));
    }

    showToast(`✅ Perfil de "${name}" excluído com sucesso.`, "success");
  } catch(e) {
    console.error("Erro ao excluir motorista:", e);
    showToast("Erro ao excluir motorista: " + e.message, "error");
  }
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
            <p style="font-size: 12px;">A conexão está demorando mais que o esperado.</p>
            <button onclick="window.loadAdminHubData()" class="mbtn mbtn-save" style="margin-top:10px; padding: 8px 16px; font-size:11px;">Tentar Reiniciar Conexão</button>
          </div>`;
      }
    }, 10000);

    window._adminHubUnsubscribe = onSnapshot(usersQ, (snapshot) => {
      clearTimeout(syncTimeout);
      
      if (snapshot.empty) {
        content.innerHTML = `<div style="padding: 40px; text-align: center; opacity: 0.5;">
          <div class="text-dark-auto" style="font-size: 13px; font-weight: 700;">Nenhum motorista vinculado</div>
          <div style="font-size: 11px; color: var(--pr-text-muted); margin-top: 5px;">Use "Minha Frota" para convidar sua equipe.</div>
        </div>`;
        return;
      }

      // Se o grid não existe, cria-o. Se existe, apenas atualizamos o que mudou.
      let grid = content.querySelector('.hub-grid');
      if (!grid) {
        content.innerHTML = '';
        grid = document.createElement('div');
        grid.className = 'hub-grid';
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(280px, 1fr))";
        grid.style.gap = "15px";
        content.appendChild(grid);
      }

      snapshot.docChanges().forEach(change => {
        const u = change.doc.data();
        const driverId = change.doc.id;
        
        if (change.type === "removed" || (u && u.role !== "driver")) {
          const existingCard = document.getElementById(`card-hub-${driverId}`);
          if (existingCard) existingCard.remove();
          return;
        }

        // Renderização Incremental (Senior approach: Don't clear everything)
        let card = document.getElementById(`card-hub-${driverId}`);
        if (!card) {
          card = document.createElement('div');
          card.id = `card-hub-${driverId}`;
          card.className = 'hub-card';
          grid.appendChild(card);
        }

        const r = u.lastRouteSummary || null;
        let displayName = u.nome || u.email || 'Motorista';
        const initial = displayName.charAt(0).toUpperCase();

        if (!r) {
          card.innerHTML = `
            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
              <div style="display: flex; gap: 12px; align-items: center;">
                <div class="fdc-avatar">${initial}</div>
                <div>
                  <div class="fdc-name" style="display:flex; align-items:center; gap:8px;">
                    ${escapeHTML(displayName)}
                  </div>
                  <div class="fdc-email" style="margin-top:6px;">${escapeHTML(u.email || "")}</div>
                </div>
              </div>
            </div>
            <div style="font-size:11px; color:var(--pr-text-muted); background:var(--pr-bg); padding:8px 10px; border-radius:8px; border:1px solid var(--pr-border); margin-top:10px;">
              Pendente: Sem histórico recente
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:8px; margin-top:10px;">
              <button onclick="window.closeAdminHub(); window.openLiveSpy('${driverId}')" class="mbtn mbtn-save" style="padding:8px; font-size:11px; background:var(--pr-blue-dark);">Visualizar</button>
              <button onclick="window.openDriverStats('${driverId}', '${escapeHTML(displayName)}')" class="mbtn mbtn-cancel" style="padding:8px; font-size:11px;">Desempenho</button>
              <button onclick="window.deleteDriver('${driverId}', '${escapeHTML(displayName)}')" class="mbtn mbtn-cancel" style="padding:8px; font-size:11px; background:#e74c3c; border-color:#c0392b;">Excluir</button>
            </div>
          `;
        } else {
          const routeStatus = r.status || "Pendente";
          let stClass = "blue";
          let stBadgeColor = "var(--pr-blue-dark)";
          
          if (routeStatus === "Concluída") { stClass = "green"; stBadgeColor = "#27ae60"; }
          else if (routeStatus === "Pendente") { stClass = "orange"; stBadgeColor = "#f39c12"; }
          else if (routeStatus === "Cancelada") { stBadgeColor = "#e74c3c"; }

          card.innerHTML = `
            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
              <div style="display: flex; align-items: center; gap: 12px;">
                <div class="fdc-avatar">${initial}</div>
                <div style="flex: 1; min-width: 0;">
                  <div class="text-dark-auto" style="font-weight:800; font-size:14px;">${escapeHTML(displayName)}</div>
                  <div style="font-size:11px; color:var(--pr-text-muted); display: flex; align-items: center; margin-top:2px;">
                    <span class="status-pulse ${stClass}"></span>
                    ${escapeHTML(routeStatus)}
                  </div>
                </div>
              </div>
              <span class="hub-status-badge" style="background: ${stBadgeColor}">${escapeHTML(routeStatus)}</span>
            </div>
            
            <div style="background: var(--pr-bg); border-radius: 8px; padding: 10px; margin-top: 10px; border: 1px dashed var(--pr-border);">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="font-size:11px; font-weight: 700; color: var(--pr-text);">
                  ${r.stopsCount || 0} Paradas 
                  ${r.expectedWeight ? ` | ${r.expectedWeight}kg` : ''}
                </div>
                <div id="hub-nearest-${driverId}" style="font-size:9px; font-weight:700; color:${stBadgeColor};"></div>
              </div>
              ${r.assignedByName ? `<div style="font-size:9px; color:var(--pr-blue-mid); margin-top:2px;">Atribuído por: ${escapeHTML(r.assignedByName)}</div>` : ''}
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:8px; margin-top:10px;">
              <button onclick="window.closeAdminHub(); window.openLiveSpy('${driverId}')" class="mbtn mbtn-save" style="padding:8px; font-size:11px; background:var(--pr-blue-dark);">Visualizar</button>
              <button onclick="window.openDriverStats('${driverId}', '${escapeHTML(displayName)}')" class="mbtn mbtn-cancel" style="padding:8px; font-size:11px;">Desempenho</button>
              <button onclick="window.deleteDriver('${driverId}', '${escapeHTML(displayName)}')" class="mbtn mbtn-cancel" style="padding:8px; font-size:11px; background:#e74c3c; border-color:#c0392b;">Excluir</button>
            </div>
          `;
          
          // Listener RTDB para localização (Otimizado: apenas uma vez)
          if (routeStatus === "Em Rota") {
             const locRef = rtdbRef(rtdb, `locations/${window.companyId}/${driverId}`);
             onValue(locRef, (lSnap) => {
                const lData = lSnap.val();
                const targetEl = document.getElementById(`hub-nearest-${driverId}`);
                if (targetEl && lData && lData.nearestStop) {
                  targetEl.textContent = `Perto de: ${lData.nearestStop.name}`;
                }
             }, { onlyOnce: true });
          }
        }
      });
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
    const driverName = udata.nome || currentUser.email || 'Motorista';

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

    // O usuário solicitou que o MAPA de monitoramento fique sempre em modo claro, 
    // independente do tema do restante do app.
    const url = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

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

  let _spyLastUids = "";

  function updateDriverPills(driversData) {
    const bar = document.getElementById('spy-driver-bar');
    if (!bar) return;

    const entries = Object.entries(driversData).filter(([uid]) => {
      return (window._fleetDrivers || []).some(d => d.uid === uid);
    });

    if (entries.length === 0) {
      _spyLastUids = "";
      bar.innerHTML = '<span style="font-size:11px;color:var(--pr-text-muted);">Nenhum motorista online agora</span>';
      document.getElementById('spy-status-txt').textContent = 'Nenhum motorista online';
      return;
    }

    const currentUids = entries.map(e => e[0]).sort().join(",");
    document.getElementById('spy-status-txt').textContent = `${entries.length} motorista${entries.length > 1 ? 's' : ''} online`;

    // Incremental update: If the set of drivers is the same, only update values to keep the animation smooth
    if (currentUids === _spyLastUids) {
      entries.forEach(([uid, data]) => {
        const speedEls = document.querySelectorAll(`.spy-speed-${uid}`);
        const agoEls = document.querySelectorAll(`.spy-ago-${uid}`);
        const speed = data.speed || 0;
        const ago = timeAgo(data.ts || Date.now());
        
        speedEls.forEach(el => el.textContent = `${speed} km/h`);
        agoEls.forEach(el => el.textContent = ago);
      });
      return;
    }

    _spyLastUids = currentUids;
    bar.innerHTML = '';

    const track = document.createElement('div');
    track.className = 'spy-driver-track';
    
    // Only loop if there's more than one driver
    const shouldLoop = entries.length > 1;
    const loops = shouldLoop ? 3 : 1;
    
    if (shouldLoop) {
      const duration = Math.max(30, entries.length * 8); 
      track.style.animation = `spyInfiniteScroll ${duration}s linear infinite`;
    } else {
      track.style.animation = 'none';
      track.style.justifyContent = 'center';
    }

    for (let loop = 0; loop < loops; loop++) {
      entries.forEach(([uid, data], i) => {
        const color = colorForIndex(i);
        const cachedDriver = (window._fleetDrivers || []).find(d => d.uid === uid);
        const name = (cachedDriver && (cachedDriver.nome)) || data.name || 'Motorista';
        const initial = name.charAt(0).toUpperCase();
        const speed = data.speed || 0;
        const ago = timeAgo(data.ts || Date.now());
        const isSelected = spyCenterUid === uid;

        const nearest = data.nearestStop;
        const nearestText = nearest ? `<div style="font-size:9px;color:${color};font-weight:700;margin-top:2px;">Próximo: ${nearest.name} (${nearest.distance}km)</div>` : '';

        const pill = document.createElement('button');
        pill.className = 'spy-pill';
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
          <div style="text-align: left;">
            <div style="font-size:11px;font-weight:700;color:var(--pr-text);">${escapeHTML(name)}</div>
            <div style="font-size:10px;color:var(--pr-text-muted);">
              <span class="spy-speed-${uid}">${speed} km/h</span> · <span class="spy-ago-${uid}">${ago}</span>
            </div>
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
        track.appendChild(pill);
      });
    }
    
    bar.appendChild(track);
  }

  function updateDriverMarkers(driversData) {
    if (!spyMap) return;
    const latlngs = [];

    // Remove markers for drivers no longer present or no longer in fleet
    Object.keys(spyMarkers).forEach(uid => {
      const cachedDriver = (window._fleetDrivers || []).find(d => d.uid === uid);
      if (!driversData[uid] || !cachedDriver) {
        spyMap.removeLayer(spyMarkers[uid]);
        delete spyMarkers[uid];
      }
    });

    const entries = Object.entries(driversData).filter(([uid]) => {
      return (window._fleetDrivers || []).some(d => d.uid === uid);
    });

    entries.forEach(([uid, data], i) => {
      if (!data.lat || !data.lng) return;
      const pos = [data.lat, data.lng];
      const color = colorForIndex(i);
      // Use the fresh Firestore name (from cache)
      const cachedDriver = (window._fleetDrivers || []).find(d => d.uid === uid);
      const name = (cachedDriver && (cachedDriver.nome)) || data.name || 'Motorista';
      const initial = name.charAt(0).toUpperCase();
      const speed = data.speed || 0;
      const ago = timeAgo(data.ts || Date.now());

      const nearest = data.nearestStop;
      const nearestHTML = nearest ? `<div style="font-size:11px;color:${color};font-weight:700;margin-top:4px;">Próximo: ${nearest.name} (${nearest.distance}km)</div>` : '';

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
          <div style="font-size:11px;color:#6B7C8E;margin-bottom:2px;">Velocidade: ${speed} km/h</div>
          <div style="font-size:11px;color:#6B7C8E;margin-bottom:4px;">Visto: ${ago}</div>
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
    listContainer.innerHTML = '<div style="text-align:center; padding:40px; color:var(--pr-text-muted); font-size:12px;">Analisando rotas...</div>';
    
    try {
      // 1. Buscar Totais Vitalícios do Usuário
      const userSnap = await getDoc(doc(db, "users", uid));
      if (userSnap.exists()) {
        const u = userSnap.data();
        document.getElementById('statTotalRoutes').textContent = u.perfTotalCompleted || 0;
        document.getElementById('statTotalValue').textContent = 'R$ ' + (u.perfTotalValue || 0).toLocaleString('pt-BR', {minimumFractionDigits:2});
        document.getElementById('statTotalWeight').textContent = (u.perfTotalWeight || 0).toLocaleString('pt-BR') + ' kg';
      }

      // 2. Carregar Histórico Recente
      const q = query(collection(db, "users", uid, "history"), orderBy("createdAt", "desc"), limit(20));
      const snap = await getDocs(q);
      
      if (snap.empty) {
        listContainer.innerHTML = '<div style="text-align:center; padding:40px; color:var(--pr-text-muted); font-size:12px;">Sem rotas recentes.</div>';
        return;
      }
      
      listContainer.innerHTML = '';
      let runningStops = 0;

      snap.forEach(docSnap => {
        const data = docSnap.data();
        const stops = (data.stopsCount || (data.stops ? data.stops.length : 0));
        runningStops += stops;
        
        const isConcluded = (data.status === 'CONCLUDED' || data.status === 'Concluída' || data.status === 'Finalizada');
        const deliveredVal = Number(data.deliveredValue || data.cargoValue || 0);
        const deliveredWeight = Number(data.deliveredWeight || data.cargoWeight || 0);
        const date = data.createdAt ? data.createdAt.toDate().toLocaleDateString('pt-BR') : '—';
        const statusClass = isConcluded ? 'concluded' : 'pending';

        const item = document.createElement('div');
        item.className = 'stats-history-card';
        item.innerHTML = `
          <div class="history-info">
            <div class="history-date">${date}</div>
            <div class="history-meta">${stops} paradas • ${data.distance || '—'} km</div>
            <div style="font-size:10px; color:var(--pr-blue-mid); margin-top:4px; font-weight:700;">
              📦 ${deliveredWeight}kg · R$ ${deliveredVal.toLocaleString('pt-BR')}
            </div>
          </div>
          <div class="history-status ${statusClass}">${isConcluded ? 'Concluída' : 'Pendente'}</div>
        `;
        listContainer.appendChild(item);
      });
      
      document.getElementById('statTotalStops').textContent = runningStops;
      
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

// ══════════════════════════════════════════════════════════
// META MENSAL — Modal, Salvar e Deduzir
// ══════════════════════════════════════════════════════════

(function() {

  // ── Constantes de ID do documento ativo ──────────────────
  const ACTIVE_GOAL_DOC = 'active';

  // Retorna ref do doc de meta ativa da empresa
  function goalRef() {
    return doc(db, 'monthly_goals', `${window.companyId}_${ACTIVE_GOAL_DOC}`);
  }

  // ── Abrir / Fechar modal ──────────────────────────────────
  window.openMonthlyGoalsModal = async function() {
    if (window.userRole !== 'admin') {
      showToast('Apenas administradores podem acessar as metas mensais.', 'error');
      return;
    }
    const modal = document.getElementById('monthlyGoalsModal');
    if (modal) modal.classList.add('active');
    
    // Começar novo ciclo marcado por padrão
    const resetCheck = document.getElementById('mgResetProgress');
    if (resetCheck) resetCheck.checked = true;

    await loadGoalIntoForm();
  };

  window.closeMonthlyGoalsModal = function() {
    document.getElementById('monthlyGoalsModal').classList.remove('active');
  };

  // ── Carregar meta ativa no formulário ────────────────────
  async function loadGoalIntoForm() {
    try {
      const snap = await getDoc(goalRef());
      if (!snap.exists()) {
        // Sem meta ainda — limpar campos com valores padrão
        ['mgCycleStart','mgCycleEnd'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        ['mgWeightMin','mgWeightMax','mgRevGoal'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = '0';
        });
        document.getElementById('mgProgressCard').style.display = 'none';
        return;
      }

      const g = snap.data();

      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
      setVal('mgCycleStart', g.cycleStart);
      setVal('mgCycleEnd',   g.cycleEnd);
      setVal('mgWeightMin',  g.weightMin);
      setVal('mgWeightMax',  g.weightMax);
      setVal('mgRevGoal',    g.revGoal);

      // Atualizar barras de progresso
      const usedWeight = g.usedWeight || 0;
      const usedValue  = g.usedValue  || 0;
      const maxWeight  = g.weightMax  || 1;
      const maxValue   = g.revGoal    || 1;

      const wPct = Math.min(100, (usedWeight / maxWeight) * 100).toFixed(1);
      const vPct = Math.min(100, (usedValue  / maxValue ) * 100).toFixed(1);

      const wBar   = document.getElementById('mgWeightBar');
      const vBar   = document.getElementById('mgValueBar');
      const wLabel = document.getElementById('mgWeightLabel');
      const vLabel = document.getElementById('mgValueLabel');
      const cLabel = document.getElementById('mgCycleLabel');

      if (wBar)   wBar.style.width   = wPct + '%';
      if (vBar)   vBar.style.width   = vPct + '%';
      if (wLabel) wLabel.textContent = `${usedWeight.toFixed(1)} / ${maxWeight} kg  (${wPct}%)`;
      if (vLabel) vLabel.textContent = `R$ ${usedValue.toFixed(2)} / R$ ${maxValue.toFixed(2)}  (${vPct}%)`;

      const startDate = g.cycleStart ? new Date(g.cycleStart + 'T00:00:00') : new Date();
      const endDate = g.cycleEnd ? new Date(g.cycleEnd + 'T23:59:59') : new Date();
      const fmtDate = d => d.toLocaleDateString('pt-BR', {day:'2-digit', month:'short'});
      if (cLabel) cLabel.textContent = `Ciclo: ${fmtDate(startDate)} → ${fmtDate(endDate)}`;

      document.getElementById('mgProgressCard').style.display = 'block';

    } catch(e) {
      console.warn('[MonthlyGoal] Erro ao carregar meta:', e.message);
    }
  }

  // ── Salvar meta ──────────────────────────────────────────
  window.saveMonthlyGoal = async function() {
    const btn = document.getElementById('mgSaveBtn');
    if (btn) { btn.textContent = '⏳ Salvando...'; btn.disabled = true; }

    const getNum = id => parseFloat(document.getElementById(id)?.value) || 0;
    const getStr = id => document.getElementById(id)?.value || '';

    const cycleStart = getStr('mgCycleStart');
    const cycleEnd   = getStr('mgCycleEnd');
    const weightMin  = getNum('mgWeightMin');
    const weightMax  = getNum('mgWeightMax');
    const revGoal    = getNum('mgRevGoal');

    if (!cycleStart || !cycleEnd) {
      showToast('Preencha as datas de Início e Término do ciclo.', 'error');
      if (btn) { btn.textContent = '💾 Salvar Meta'; btn.disabled = false; }
      return;
    }
    if (!weightMax || !revGoal) {
      showToast('Preencha a meta de Peso Máximo e Faturamento.', 'error');
      if (btn) { btn.textContent = '💾 Salvar Meta'; btn.disabled = false; }
      return;
    }

    try {
      let usedWeight = 0, usedValue = 0;
      const shouldReset = document.getElementById('mgResetProgress')?.checked;

      if (!shouldReset) {
        try {
          const snap = await getDoc(goalRef());
          if (snap.exists()) {
            usedWeight = snap.data().usedWeight || 0;
            usedValue  = snap.data().usedValue  || 0;
          }
        } catch(_) { /* ignore if new */ }
      }

      await setDoc(goalRef(), {
        companyId:   window.companyId,
        cycleStart,
        cycleEnd,
        weightMin,
        weightMax,
        revGoal,
        usedWeight,
        usedValue,
        updatedAt: serverTimestamp()
      });

      showToast('Meta mensal salva com sucesso!', 'success');
      await loadGoalIntoForm();

      // Fechar modal de configuração e abrir dashboard de analytics
      window.closeMonthlyGoalsModal();
      window.openGoalsDashboard();

    } catch(e) {
      console.error('[MonthlyGoal] Erro ao salvar:', e);
      showToast('Erro ao salvar meta: ' + e.message, 'error');
    } finally {
      if (btn) { btn.textContent = '💾 Salvar Meta'; btn.disabled = false; }
    }
  };

  // ── Dashboard de Análise de Metas (V3 - ApexCharts) ──────────────────────
  let goalCharts = { daily: null, weekly: null, trend: null, gaugeW: null, gaugeV: null };

  window.openGoalsDashboard = async function() {
    const panel = document.getElementById('goalsDashboardPanel');
    if (!panel) return;
    
    if (window.closeFleetPanel) window.closeFleetPanel();

    ['dailyRouteCard', 'pdRouteDetails', 'mapStatsPill'].forEach(id => {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    });

    panel.style.display = 'flex';
    
    // 1. Carregar Meta Ativa
    const snap = await getDoc(goalRef());
    if (!snap.exists()) {
      showToast("Nenhuma meta configurada. Configure a meta primeiro.", "error");
      return;
    }
    const g = snap.data();
    
    const startDate = g.cycleStart ? new Date(g.cycleStart + 'T00:00:00') : new Date();
    const endDate = g.cycleEnd ? new Date(g.cycleEnd + 'T23:59:59') : new Date();

    const usedW = g.usedWeight || 0;
    const goalW = g.weightMax || 1;
    const usedV = g.usedValue || 0;
    const goalV = g.revGoal || 1;

    // 2. Footer Stats e Cálculos
    const now = new Date();
    const diffDays = Math.max(0, Math.ceil((endDate - now) / (1000 * 60 * 60 * 24)));
    
    const setStat = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    
    setStat('heroStatPesoRest', `${Math.max(0, goalW - usedW).toFixed(1)} kg`);
    setStat('heroStatValRest', `R$ ${Math.max(0, goalV - usedV).toLocaleString('pt-BR')}`);
    setStat('heroStatDiasRest', diffDays);

    // 3. Renderizar Gauges Iniciais
    renderGauges(usedW, goalW, usedV, goalV);

    // 4. Buscar e Renderizar Gráficos de Performance
    await fetchAndRenderPerformanceV3(startDate, endDate);
  };

  window.closeGoalsDashboard = function() {
    const panel = document.getElementById('goalsDashboardPanel');
    if (panel) panel.style.display = 'none';
    
    const fleetPanel = document.getElementById('fleetPanel');
    const isFleetOpen = fleetPanel && fleetPanel.style.display !== 'none';
    
    if (!isFleetOpen) {
      ['dailyRouteCard', 'pdRouteDetails', 'mapStatsPill'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = '';
      });
    }
  };

  function renderGauges(usedW, goalW, usedV, goalV) {
    const commonOptions = (color, label) => ({
      chart: { height: 180, type: 'radialBar', sparkline: { enabled: true } },
      plotOptions: {
        radialBar: {
          startAngle: -90,
          endAngle: 90,
          hollow: { size: '65%' },
          track: {
            background: '#e7e7e7',
            strokeWidth: '97%',
            margin: 5,
          },
          dataLabels: {
            name: { show: true, color: '#888', fontSize: '11px', offsetY: -10 },
            value: { offsetY: -5, fontSize: '18px', fontWeight: 700, color: '#333' }
          }
        }
      },
      colors: [color],
      labels: [label]
    });

    const wPct = Math.min(100, (usedW / goalW) * 100);
    const vPct = Math.min(100, (usedV / goalV) * 100);

    if (goalCharts.gaugeW) goalCharts.gaugeW.destroy();
    goalCharts.gaugeW = new ApexCharts(document.querySelector("#gaugeWeightChart"), {
      ...commonOptions('#1A6BAF', 'Peso'),
      series: [wPct.toFixed(1)]
    });
    goalCharts.gaugeW.render();

    if (goalCharts.gaugeV) goalCharts.gaugeV.destroy();
    goalCharts.gaugeV = new ApexCharts(document.querySelector("#gaugeValueChart"), {
      ...commonOptions('#27ae60', 'Faturamento'),
      series: [vPct.toFixed(1)]
    });
    goalCharts.gaugeV.render();
  }

  async function fetchAndRenderPerformanceV3(startDate, endDate) {
    try {
      const driversSnap = await getDocs(collection(db, "users"));
      const driverIds = [];
      driversSnap.forEach(d => { if(d.data().role === 'driver') driverIds.push(d.id); });

      let dailyData = {};
      let weeklyData = [0, 0, 0, 0, 0];
      let trendData = { concluídas: {}, pendentes: {} };
      let concludedCount = 0;
      let pendingCount = 0;

      const historyPromises = driverIds.map(async (uid) => {
        const q = query(
          collection(db, "users", uid, "history"),
          where("createdAt", ">=", startDate),
          where("createdAt", "<=", endDate)
        );
        const hSnap = await getDocs(q);
        hSnap.forEach(doc => {
          const data = doc.data();
          const weight = Number(data.deliveredWeight || data.cargoWeight || 0);
          const dateObj = data.createdAt.toDate();
          const dateStr = dateObj.toISOString().split('T')[0];
          const isDone = (data.status === 'CONCLUDED' || data.status === 'Concluída');

          if (isDone) {
            concludedCount++;
            dailyData[dateStr] = (dailyData[dateStr] || 0) + weight;
            const diffDays = Math.floor((dateObj - startDate) / (1000 * 60 * 60 * 24));
            const weekIdx = Math.floor(diffDays / 7);
            if (weekIdx >= 0 && weekIdx < 5) weeklyData[weekIdx] += weight;
            trendData.concluídas[dateStr] = (trendData.concluídas[dateStr] || 0) + 1;
          } else {
            pendingCount++;
            trendData.pendentes[dateStr] = (trendData.pendentes[dateStr] || 0) + 1;
          }
        });
      });

      await Promise.all(historyPromises);

      // Update UI Counters
      document.getElementById('heroStatTotalEntregas').textContent = concludedCount;
      document.getElementById('conclVal').textContent = concludedCount;
      document.getElementById('pendVal').textContent = pendingCount;
      
      const total = (concludedCount + pendingCount) || 1;
      document.getElementById('conclBar').style.width = (concludedCount / total * 100) + '%';
      document.getElementById('pendBar').style.width = (pendingCount / total * 100) + '%';

      renderDailyChartV3(dailyData);
      renderWeeklyChartV3(weeklyData);
      renderTrendChartV3(trendData);

    } catch(e) {
      console.warn('[Analytics] Erro ao processar:', e);
    }
  }

  function renderDailyChartV3(data) {
    const days = [];
    const values = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const s = d.toISOString().split('T')[0];
      days.push(d.toLocaleDateString('pt-BR', {weekday: 'short'}).toUpperCase());
      values.push((data[s] || 0).toFixed(1));
    }

    const options = {
      series: [{ name: 'Peso (kg)', data: values }],
      chart: { type: 'bar', height: 200, toolbar: { show: false }, zoom: { enabled: false } },
      colors: ['#1A6BAF'],
      plotOptions: { bar: { borderRadius: 4, columnWidth: '50%' } },
      xaxis: { categories: days, labels: { style: { fontSize: '10px' } } },
      yaxis: { labels: { style: { fontSize: '10px' } } },
      dataLabels: { enabled: false },
      tooltip: { theme: 'dark' }
    };

    if (goalCharts.daily) goalCharts.daily.destroy();
    goalCharts.daily = new ApexCharts(document.querySelector("#dailyPerfChart"), options);
    goalCharts.daily.render();
  }

  function renderWeeklyChartV3(data) {
    const options = {
      series: [{ name: 'Peso (kg)', data: data.map(v => v.toFixed(1)) }],
      chart: { type: 'bar', height: 200, toolbar: { show: false } },
      colors: ['#0D3B66'],
      plotOptions: { bar: { borderRadius: 4, columnWidth: '60%' } },
      xaxis: { categories: ['SEM 1', 'SEM 2', 'SEM 3', 'SEM 4', 'SEM 5'], labels: { style: { fontSize: '10px' } } },
      dataLabels: { enabled: false },
      tooltip: { theme: 'dark' }
    };

    if (goalCharts.weekly) goalCharts.weekly.destroy();
    goalCharts.weekly = new ApexCharts(document.querySelector("#weeklyPerfChart"), options);
    goalCharts.weekly.render();
  }

  function renderTrendChartV3(trend) {
    const allDates = Object.keys({...trend.concluídas, ...trend.pendentes}).sort();
    const categories = allDates.map(d => d.split('-').slice(1).reverse().join('/'));

    const options = {
      series: [
        { name: 'Concluídas', data: allDates.map(d => trend.concluídas[d] || 0) },
        { name: 'Pendentes', data: allDates.map(d => trend.pendentes[d] || 0) }
      ],
      chart: { type: 'line', height: 160, toolbar: { show: false }, background: 'transparent' },
      stroke: { curve: 'smooth', width: 3 },
      colors: ['#1A6BAF', '#e67e22'],
      markers: { size: 4 },
      xaxis: { categories: categories, labels: { style: { fontSize: '9px' } } },
      yaxis: { labels: { style: { fontSize: '9px' } } },
      legend: { show: false },
      grid: { borderColor: '#f1f1f1' }
    };

    if (goalCharts.trend) goalCharts.trend.destroy();
    goalCharts.trend = new ApexCharts(document.querySelector("#statusTrendChart"), options);
    goalCharts.trend.render();
  }

  // ── Deduzir peso e valor da meta ativa ───────────────────
  // Chamado por generateManualRoute após salvar a rota
  window.deductFromMonthlyGoal = async function(weight, value) {
    if (!weight && !value) return;
    try {
      const snap = await getDoc(goalRef());
      if (!snap.exists()) return; // Sem meta configurada — silencioso

      const g = snap.data();

      // Verificar se data atual está dentro do ciclo
      const now = new Date();
      const startDate = g.cycleStart ? new Date(g.cycleStart + 'T00:00:00') : new Date(0);
      const endDate = g.cycleEnd ? new Date(g.cycleEnd + 'T23:59:59') : new Date(0);
      
      const inCycle = now >= startDate && now <= endDate;

      if (!inCycle) {
        console.log('[MonthlyGoal] Fora do ciclo — sem dedução.');
        return;
      }

      const newUsedWeight = (g.usedWeight || 0) + (weight || 0);
      const newUsedValue  = (g.usedValue  || 0) + (value  || 0);

      await updateDoc(goalRef(), {
        usedWeight: newUsedWeight,
        usedValue:  newUsedValue,
        lastDeductedAt: serverTimestamp()
      });

      console.log(`[MonthlyGoal] Deduzido: ${weight}kg / R$${value} → Total: ${newUsedWeight}kg / R$${newUsedValue}`);
    } catch(e) {
      console.warn('[MonthlyGoal] Erro na dedução:', e.message);
    }
  };

})();
