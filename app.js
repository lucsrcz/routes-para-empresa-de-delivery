import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, serverTimestamp, query, orderBy, limit, onSnapshot, doc, updateDoc, deleteDoc, getDoc, setDoc, where, writeBatch } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";

const firebaseConfig = {
  projectId: "rotas-cabun-app",
  appId: "1:1017676204969:web:226223216f8dde86a752b8",
  storageBucket: "rotas-cabun-app.firebasestorage.app",
  apiKey: "AIzaSyCwFuaNuzw50bn9CV2RnP3xTx8TNcFr6D4",
  authDomain: "rotas-cabun-app.firebaseapp.com",
  messagingSenderId: "1017676204969",
  measurementId: "G-YDQLXK9YHY"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
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



window.userRole = "driver"; // Padrão global

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
      const querySnapshot = await getDocs(q);
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
      console.warn("Erro ao carregar lista de motoristas:", e);
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

window.startMission = async function(missionId) {
  try {
    await updateDoc(doc(db, "users", currentUser.uid, "history", missionId), {
      status: "Em Rota",
      startedAt: serverTimestamp()
    });
  } catch(e) {
    console.warn("Erro ao iniciar rota:", e);
  }
};

// Function moved to bottom to merge with admin logic
window.finishMission = async function(missionId) {
  if (confirm("Deseja marcar esta rota como Concluída?")) {
    try {
      await updateDoc(doc(db, "users", currentUser.uid, "history", missionId), {
        status: "Concluída"
      });
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
    window.location.href = "routes_login.html";
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
      const mD = document.getElementById('mapDist');
      const mT = document.getElementById('mapTime');
      const mS = document.getElementById('mapStops');
      if(mD) mD.textContent = data.distance + ' km';
      if(mT) mT.textContent = data.time + ' min';
      if(mS) mS.textContent = data.stopsCount;
      
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
      const selectedCard = document.querySelector('.builder-driver-card.selected');
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

    // Reset do botão em background
    setTimeout(resetBtn, 1500);

    // 4) Tentar calcular detalhes e trajeto em BACKGROUND (sem travar nada)
    try {
      if (typeof google !== 'undefined' && google.maps) {
        if (!userCoords) {
          try {
            const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, {timeout: 3000}));
            userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          } catch(e) { /* sem GPS, ok */ }
        }
        
        if (userCoords) {
          const directionsService = new google.maps.DirectionsService();
          const getClean = (p) => {
            if (p.lat && p.lng && !isNaN(p.lat)) return new google.maps.LatLng(Number(p.lat), Number(p.lng));
            return p.name || p.originalInput || "Local";
          };
          const checkCoord = (c) => typeof c === 'number' && !isNaN(c);

          directionsService.route({
            origin: checkCoord(userCoords.lat) ? new google.maps.LatLng(userCoords.lat, userCoords.lng) : "Seu Local",
            destination: getClean(lastP),
            waypoints: builderSelectedPoints.length > 1 ? builderSelectedPoints.slice(0, -1).map(p => ({ location: getClean(p), stopover: true })) : [],
            travelMode: google.maps.TravelMode.DRIVING
          }, async (response, status) => {
            if (status === 'OK') {
              const route = response.routes[0];
              let tM = 0; let tS = 0;
              route.legs.forEach(leg => { tM += leg.distance.value; tS += leg.duration.value; });
              const dk = (tM / 1000).toFixed(1);
              const tm = Math.round(tS / 60);

              // Atualizar DIRETAMENTE o documento recém-criado na base de dados certa
              await updateDoc(newRouteRef, {
                distance: dk,
                time: tm,
                polyline: route.overview_polyline || ""
              });
              console.log("✅ Detalhes da rota atualizados em background:", dk + "km", tm + "min");
            }
          });
        }
      }
    } catch(bgErr) {
      console.warn("Cálculo em background falhou (ok, rota já foi salva):", bgErr);
    }

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
      // Atualiza o banco, mas SEM usar "await" para não atrasar a tela e cair no bloqueador de popups.
      updateDoc(doc(db, "users", currentUser.uid, "history", window.activeRouteId), {
        status: "Em Rota"
      }).catch(e => console.warn("Falha ao atualizar status", e));
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
    window.openRouteFromCard();
  }
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

      // Checar última rota do motorista
      let statusClass = 'idle';
      let statusText = 'Sem rota';
      let routeInfo = 'Nenhuma rota atribuída';

      try {
        const hq = query(collection(db, "users", docSnap.id, "history"), orderBy("createdAt", "desc"), limit(1));
        const hSnap = await getDocs(hq);
        if (!hSnap.empty) {
          const routeData = hSnap.docs[0].data();
          const st = routeData.status || 'Pendente';
          if (st === 'Pendente') { statusClass = 'pending'; statusText = 'Pendente'; }
          else if (st === 'Concluída') { statusClass = 'active'; statusText = 'Concluída'; }
          else { statusClass = 'active'; statusText = st; }
          routeInfo = (routeData.stopsCount || 0) + ' parada' + ((routeData.stopsCount || 0) > 1 ? 's' : '');
        }
      } catch(e) { /* silencioso */ }

      const card = document.createElement('div');
      card.className = 'fleet-driver-card';
      card.innerHTML = `
        <div class="fdc-preview">
          <img src="capa.png" alt="${escapeHTML(displayName)}">
          <span class="fdc-status ${statusClass}">${statusText}</span>
        </div>
        <div class="fdc-content">
          <h4 class="fdc-name">${escapeHTML(displayName)}</h4>
          <p class="fdc-email">${escapeHTML(email)}</p>
          <div class="fdc-footer">
            <span class="fdc-route-info">📍 ${routeInfo}</span>
            <div class="fdc-avatar">${initial}</div>
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
// FLEET MANAGEMENT — Convidar e listar motoristas
// ══════════════════════════════════════════════════════════

window.openFleetModal = function() {
  document.getElementById('fleetModal').classList.add('active');
  document.getElementById('inviteLinkResult').style.display = 'none';
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
};

async function loadAdminHubData() {
  const content = document.getElementById('adminHubContent');
  content.innerHTML = '<p style="text-align:center; font-size:12px; color:var(--pr-text-muted);">Buscando motoristas, um momento...</p>';
  try {
    const usersQ = query(collection(db, "users"), where("adminId", "==", window.companyId));
    const snapshot = await getDocs(usersQ);
    content.innerHTML = '';
    
    if (snapshot.empty) {
      content.innerHTML = '<p style="text-align:center; font-size:12px;">Nenhum motorista vinculado. Use "Minha Frota" para convidar.</p>';
      return;
    }

    for (const userDoc of snapshot.docs) {
      const u = userDoc.data();
      if (u.role === "driver") {
        // Obter a última rota
        const hQ = query(collection(db, "users", userDoc.id, "history"), orderBy("createdAt", "desc"), limit(1));
        const hSnap = await getDocs(hQ);
        
        const card = document.createElement('div');
        card.style.background = "var(--pr-surface)";
        card.style.padding = "12px";
        card.style.borderRadius = "8px";
        card.style.borderLeft = "4px solid var(--pr-blue-dark)";
        card.style.border = "1px solid var(--pr-border)";
        card.style.boxShadow = "0 1px 3px rgba(0,0,0,0.05)";
        
        let driverName = u.nome || u.email || 'Motorista';
        const displayEdit = `🚗 ${escapeHTML(driverName)} <span style="font-size:10px; cursor:pointer;" title="Editar Nome do Motorista" onclick="renameDriver('${userDoc.id}', '${(u.nome || u.email || '').replace(/'/g, "\\'")}')">✏️</span>`;
        
        if (hSnap.empty) {
          card.innerHTML = `<div class="text-dark-auto" style="font-weight:700; font-size:13px;">${displayEdit}</div>
                            <div style="font-size:11px; color:var(--pr-text-muted); margin-top:4px;">Nenhuma rota no histórico</div>`;
        } else {
          const r = hSnap.docs[0].data();
          const routeStatus = r.status || "Pendente";
          let stColor = routeStatus === "Pendente" ? "orange" : (routeStatus === "Concluída" ? "#00e676" : "#2196f3");
          
          let stopsCount = r.stopsCount || "?";
          let startedTimeHTML = '';
          if (r.startedAt && r.startedAt.toDate) {
            const dObj = r.startedAt.toDate();
            startedTimeHTML = `<br><span style="color:#2196f3; font-weight:600; background:rgba(33, 150, 243, 0.1); padding:2px 6px; border-radius:4px; display:inline-block; margin-top:4px;">⏱ Saída: ${dObj.toLocaleDateString('pt-BR')} às ${dObj.toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}</span>`;
          }
          
          let hrefUrl = r.mapsUrl || "#";
          
          card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div class="text-dark-auto" style="font-weight:700; font-size:13px;">${displayEdit}</div>
              <span style="font-size:10px; background:${stColor}; color:#fff; padding:2px 6px; border-radius:10px; font-weight:bold;">${escapeHTML(routeStatus)}</span>
            </div>
            <div style="font-size:11px; color:var(--pr-text-muted); margin-top:4px;">${stopsCount} paradas registradas na rota atual.${startedTimeHTML}</div>
            <a href="${sanitizeUrl(hrefUrl)}" target="_blank" style="display:inline-block; margin-top:8px; font-size:10px; background:var(--pr-bg); padding:4px 8px; border-radius:4px; text-decoration:none; color:var(--pr-blue-dark); font-weight:bold;">🗺 Espionar Rota</a>
          `;
        }
        content.appendChild(card);
      }
    }

  } catch(e) {
    console.warn("Erro ao carregar hub", e);
    content.innerHTML = '<p style="text-align:center; color:red; font-size:12px;">Erro ao carregar dados.</p>';
  }
}

// Inicia o loop de atualização (a cada 1 segundo)
setInterval(updateCardDate, 1000);
updateCardDate();
