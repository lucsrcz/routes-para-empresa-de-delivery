import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getFirestore, collection, addDoc, getDocs, serverTimestamp, query, orderBy, limit, onSnapshot, doc, updateDoc, deleteDoc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";

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

// Sanitização XSS — escapa HTML em conteúdo dinâmico
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
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

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

window.userRole = "driver"; // Padrão global

async function applyRoleUI() {
  console.log("Seu nível de acesso detectado:", window.userRole);
  const adminArea = document.getElementById('adminDriverArea');
  const adminBtn = document.getElementById('adminHubBtn');
  
  if (window.userRole === "admin") {
    if (adminArea) adminArea.style.display = "block";
    if (adminBtn) adminBtn.style.display = "flex";
    
    try {
      const q = query(collection(db, "users"));
      const querySnapshot = await getDocs(q);
      const select = document.getElementById('adminDriverSelect');
      
      if (select) {
        select.innerHTML = '<option value="">✅ Para mim</option>';
        querySnapshot.forEach((docSnap) => {
          const u = docSnap.data();
          if (u.role === "driver") {
            const opt = document.createElement('option');
            opt.value = docSnap.id;
            opt.textContent = `🚗 ${u.name || u.email || 'Motorista'}`;
            select.appendChild(opt);
          }
        });
      }
    } catch(e) {
      console.warn("Erro ao carregar lista de motoristas:", e);
    }
  } else {
    if (adminArea) adminArea.style.display = "none";
    if (adminBtn) adminBtn.style.display = "none";
  }
}

window.renameDriver = async function(uid, oldName) {
  const newName = prompt("Digite o nome desse motorista:", oldName || "");
  if (newName !== null && newName.trim() !== "") {
    try {
      await updateDoc(doc(db, "users", uid), { name: newName.trim() });
      loadAdminHubData();
      applyRoleUI();
    } catch(e) {
      alert("Erro: " + e.message);
    }
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "routes_login.html";
  } else {
    currentUser = user;
    
    // Configuração de Identidade e Papel (Role)
    try {
      const userRef = doc(db, "users", currentUser.uid);
      const userSnap = await getDoc(userRef);
      const isAdminEmail = currentUser.email === "lucsrcz@gmail.com";
      
      if (!userSnap.exists()) {
        window.userRole = isAdminEmail ? "admin" : "driver";
        await setDoc(userRef, {
          email: currentUser.email,
          role: window.userRole,
          createdAt: serverTimestamp()
        });
      } else {
        window.userRole = userSnap.data().role || "driver";
      }

      // Upgrade de segurança: Força a carteira de Admin para o seu e-mail caso não esteja
      if (isAdminEmail && window.userRole !== "admin") {
         await updateDoc(userRef, { role: "admin" });
         window.userRole = "admin";
      }

      applyRoleUI();
    } catch(err) {
      console.warn("Erro ao configurar permissões do usuário", err);
    }

    loadLocations();
  }
});

window.handleLogout = async function() {
  if(confirm("Deseja realmente sair?")) {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Erro ao sair", error);
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
      <div class="loc-info">
        <div class="loc-name">
          <a href="${hrefUrl}" target="_blank" style="color:inherit;text-decoration:none;">${escapeHTML(data.name) || 'Endereço'}</a>
          <a href="${hrefUrl}" target="_blank" class="loc-link-icon" title="Abrir no Google Maps">↗</a>
        </div>
        <div class="loc-addr">${data.lat && data.lng ? `Lat: ${data.lat}, Lng: ${data.lng}` : escapeHTML(data.originalInput.substring(0,30))+'...'}</div>
      </div>
      <div class="loc-actions">
         <button class="ia-btn" onclick="openEditModal('${data.id}', '${safeName}', '${safeLink}')" title="Editar">✏</button>
         <button class="ia-btn" style="color:#e06666;" onclick="deleteLocation('${data.id}')" title="Excluir">🗑</button>
      </div>
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
  
  const q = query(collection(db, "users", currentUser.uid, "locations"), orderBy("name", "asc"));
  onSnapshot(q, (snapshot) => {
    const list = document.getElementById('searchList');
    allLocations = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      data.id = docSnap.id;
      allLocations.push(data);
    });
    
    renderSearchAgenda();

    if(document.getElementById('builderModal').classList.contains('active')) {
       renderBuilderLocations();
    }
  });

  const qRecent = query(collection(db, "users", currentUser.uid, "locations"), orderBy("createdAt", "desc"), limit(5));
  onSnapshot(qRecent, (snapshot) => {
    const rList = document.getElementById('recentList');
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
      
      const rL = document.getElementById('routeStopList');
      if(rL && data.points) {
        const names = data.points.map((p, i) => `${i+1}. ${p.name || 'Local'}`).join('<br>');
        rL.innerHTML = `<strong>Última Rota:</strong><br><span style="color:var(--pr-blue-mid)">● Início: Minha Localização</span><br>${names}`;
      }

      // Sincronizar Card Flutuante
      window.currentRouteUrl = data.mapsUrl || "";
      
      // Título: "Rota Manual" + Visor de Status
      const drcTitle = document.getElementById('drcTitle');
      const st = data.status || "Pendente";
      let stColor = st === "Pendente" ? "orange" : (st === "Concluída" ? "#00e676" : "#2196f3");
      if(drcTitle) drcTitle.innerHTML = `Rota Manual <span style="font-size:10px; background:\${stColor}; color:#fff; padding:2px 6px; border-radius:10px; margin-left:6px; font-weight:bold;">\${st}</span>`;

      // Descrição: lista dos locais da rota
      const drcDate = document.getElementById('drcDate');
      if(drcDate && data.points) {
        const stopNames = data.points.map(p => p.name || 'Local').join(', ');
        const distInfo = data.distance !== "—" ? ` • ${data.distance}km` : "";
        const timeInfo = data.time !== "—" ? ` • ${data.time}min` : "";
        drcDate.textContent = `Rota: ${stopNames}${distInfo}${timeInfo}`;
      }

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

window.finishActiveRoute = async function() {
  if (confirm("Deseja marcar esta rota como Concluída?")) {
    if (window.activeRouteId) {
      try {
        await updateDoc(doc(db, "users", currentUser.uid, "history", window.activeRouteId), {
           status: "Concluída"
        });
        alert("Excelente! Rota concluída. O administrador já pode ver no painel.");
      } catch(e) {
        console.warn("Erro ao concluir", e);
      }
    }
  }
};

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
};

window.closeBuilderModal = function() {
  document.getElementById('builderModal').classList.remove('active');
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
      <div style="flex:1; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--pr-text); font-weight:600;">${loc.name || loc.originalInput}</div>
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

  try {
    if(!currentUser) {
      alert("Aguarde a autenticação conectar ou faça login novamente.");
      if (genBtn) { genBtn.textContent = "🗺 Gerar Rota"; genBtn.style.pointerEvents = "auto"; genBtn.style.opacity = "1"; }
      return;
    }

    if(builderSelectedPoints.length < 1) {
      alert("Selecione pelo menos 1 ponto.");
      if(genBtn) { genBtn.textContent = "🗺 Gerar Rota"; genBtn.style.pointerEvents = "auto"; genBtn.style.opacity = "1"; }
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

    // 2) Preparar URL e fechar a janela imediatamente para o usuário não esperar
    window.currentRouteUrl = mapsUrl;
    
    // Feedback + fechar modal IMEDIATAMENTE
    if(genBtn) { 
      genBtn.textContent = "✅ Rota Gerada!";
    }
    const builderModal = document.getElementById('builderModal');
    if(builderModal) builderModal.classList.remove('active');

    // Reset do botão em background
    setTimeout(() => {
      if(genBtn) { genBtn.textContent = "🗺 Gerar Rota"; genBtn.style.pointerEvents = "auto"; genBtn.style.opacity = "1"; }
    }, 1500);

    // 3) Identificar para quem despachar a rota (Admin ou Próprio)
    let targetUid = currentUser.uid;
    const isDesktop = window.innerWidth >= 768;
    if (window.userRole === "admin" && isDesktop) {
      const driverSelect = document.getElementById('adminDriverSelect');
      if (driverSelect && driverSelect.value) {
        targetUid = driverSelect.value;
      }
    }

    // 3) Salvar no banco (vai disparar o listener do Firestore que atualiza o card do Usuário Alvo)
    const newRouteRef = await addDoc(collection(db, "users", targetUid, "history"), {
      points: builderSelectedPoints.map(p => ({name: p.name, input: p.originalInput, lat: p.lat||null, lng: p.lng||null})),
      distance: "—", time: "—", stopsCount: builderSelectedPoints.length, 
      polyline: "",
      mapsUrl: mapsUrl,
      status: "Pendente",
      createdAt: serverTimestamp()
    });

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
    if (genBtn) {
      genBtn.textContent = "🗺 Gerar Rota";
      genBtn.style.pointerEvents = "auto";
      genBtn.style.opacity = "1";
    }
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
  if (window.currentRouteUrl) {
    const routeUrl = window.currentRouteUrl;
    
    if (window.activeRouteId) {
      // Atualiza o banco, mas SEM usar "await" para não atrasar a tela e cair no bloqueador de popups.
      updateDoc(doc(db, "users", currentUser.uid, "history", window.activeRouteId), {
        status: "Em Viagem"
      }).catch(e => console.warn("Falha ao atualizar status", e));
    }

    // Logo em seguida e na mesma fração de segundo, abrimos o Maps:
    window.open(routeUrl, '_blank');
  } else {
    alert("Nenhuma rota ativa. Gere uma rota primeiro!");
  }
};

// PAINEL DA FROTA P/ ADMIN
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
    const usersQ = query(collection(db, "users"));
    const snapshot = await getDocs(usersQ);
    content.innerHTML = '';
    
    if (snapshot.empty) {
      content.innerHTML = '<p style="text-align:center; font-size:12px;">Nenhum usuário encontrado.</p>';
      return;
    }

    snapshot.forEach(async (userDoc) => {
      const u = userDoc.data();
      if (u.role === "driver") {
        // Obter a última rota
        const hQ = query(collection(db, "users", userDoc.id, "history"), orderBy("createdAt", "desc"), limit(1));
        const hSnap = await getDocs(hQ);
        
        const card = document.createElement('div');
        card.style.background = "#fff";
        card.style.padding = "12px";
        card.style.borderRadius = "8px";
        card.style.borderLeft = "4px solid var(--pr-blue-dark)";
        card.style.boxShadow = "0 1px 3px rgba(0,0,0,0.05)";
        
        let driverName = u.name || u.email || 'Motorista';
        const displayEdit = `🚗 ${driverName} <span style="font-size:10px; cursor:pointer;" title="Editar Nome do Motorista" onclick="renameDriver('${userDoc.id}', '${u.name || u.email}')">✏️</span>`;
        
        if (hSnap.empty) {
          card.innerHTML = `<div style="font-weight:700; font-size:13px; color:var(--pr-text);">${displayEdit}</div>
                            <div style="font-size:11px; color:gray; margin-top:4px;">Nenhuma rota no histórico</div>`;
        } else {
          const r = hSnap.docs[0].data();
          const routeStatus = r.status || "Pendente";
          let stColor = routeStatus === "Pendente" ? "orange" : (routeStatus === "Concluída" ? "#00e676" : "#2196f3");
          
          let stopsCount = r.stopsCount || "?";
          
          let hrefUrl = r.mapsUrl || "#";
          
          card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div style="font-weight:700; font-size:13px; color:var(--pr-text);">${displayEdit}</div>
              <span style="font-size:10px; background:\${stColor}; color:#fff; padding:2px 6px; border-radius:10px; font-weight:bold;">\${routeStatus}</span>
            </div>
            <div style="font-size:11px; color:gray; margin-top:4px;">\${stopsCount} paradas registradas na rota atual.</div>
            <a href="\${hrefUrl}" target="_blank" style="display:inline-block; margin-top:8px; font-size:10px; background:var(--pr-bg); padding:4px 8px; border-radius:4px; text-decoration:none; color:var(--pr-blue-dark); font-weight:bold;">🗺 Espionar Rota</a>
          `;
        }
        content.appendChild(card);
      }
    });

  } catch(e) {
    console.warn("Erro ao carregar hub", e);
    content.innerHTML = '<p style="text-align:center; color:red; font-size:12px;">Erro ao carregar dados.</p>';
  }
}

// Inicia o loop de atualização (a cada 1 segundo)
setInterval(updateCardDate, 1000);
updateCardDate();
