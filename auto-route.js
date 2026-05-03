/**
 * ══════════════════════════════════════════════════════════
 *  AUTO-ROUTE V2 — Sistema de Rota Automática Inteligente
 *  Padrão Senior: Resiliência Máxima e Performance
 * ══════════════════════════════════════════════════════════
 */
(function() {
  'use strict';

  // ── Configurações ──
  const CONFIG = {
    OSRM_MAX_POINTS: 25, // Limite para API gratuita OSRM
    GEOLOCATION_TIMEOUT: 5000,
    AUTO_CALC_DELAY: 1000
  };

  // ── State (Privado) ──
  let state = {
    locations: [],
    sorted: [],
    phase: 'idle',
    totalKm: 0,
    autoTimer: null,
    usedOSRM: false,
    userCoords: null
  };

  // ── Utilitários Matemáticos ──
  const GeoUtils = {
    /** Distância Haversine entre dois pontos (km) */
    haversine: (lat1, lng1, lat2, lng2) => {
      if (window.haversineKm) return window.haversineKm(lat1, lng1, lat2, lng2);
      // Fallback local se o app.js ainda não carregou
      if (![lat1, lng1, lat2, lng2].every(v => v !== null && !isNaN(v))) return Infinity;
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLng = (lng2 - lng1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    },

    /** Extração Robusta de Coordenadas de URLs */
    extractCoords: (input) => {
      if (window.extractCoordsFromUrl) return window.extractCoordsFromUrl(input);
      if (!input || typeof input !== 'string') return null;
      const raw = input.trim();
      const patterns = [
        /(-?\d+\.\d+),(-?\d+\.\d+)/,
        /@(-?\d+\.\d+),(-?\d+\.\d+)/,
        /[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/
      ];
      for (const regex of patterns) {
        const match = raw.match(regex);
        if (match) {
          const lat = parseFloat(match[1]);
          const lng = parseFloat(match[2]);
          if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
        }
      }
      return null;
    }
  };

  // ── Engine de Otimização ──
  const RouteEngine = {
    /** Algoritmo Nearest Neighbor (Guldoso) */
    solve: (startLat, startLng, points) => {
      const valid = points.filter(p => p.lat !== null && p.lng !== null);
      const invalid = points.filter(p => p.lat === null || p.lng === null);
      
      const remaining = [...valid];
      const sorted = [];
      let currentLat = startLat;
      let currentLng = startLng;

      // Se não temos ponto de partida (null ou undefined), usamos o primeiro ponto prioritário ou o primeiro válido
      if (currentLat == null && remaining.length > 0) {
        const firstIdx = remaining.findIndex(p => p.priority) !== -1 
          ? remaining.findIndex(p => p.priority) 
          : 0;
        const first = remaining.splice(firstIdx, 1)[0];
        sorted.push(first);
        currentLat = first.lat;
        currentLng = first.lng;
      }

      while (remaining.length > 0) {
        let bestIdx = 0;
        let bestDist = Infinity;

        // Prioriza pontos marcados como prioridade primeiro
        const hasPriority = remaining.some(p => p.priority);
        
        for (let i = 0; i < remaining.length; i++) {
          if (hasPriority && !remaining[i].priority) continue;

          const d = GeoUtils.haversine(currentLat, currentLng, remaining[i].lat, remaining[i].lng);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }

        const chosen = remaining.splice(bestIdx, 1)[0];
        sorted.push(chosen);
        currentLat = chosen.lat;
        currentLng = chosen.lng;
      }

      return [...sorted, ...invalid];
    }
  };

  // ── Funções de UI & Eventos ──
  
  window.openAutoRouteModal = function() {
    if (window.closeRouteChoiceModal) window.closeRouteChoiceModal();
    
    // Obtém locais da agenda global
    const rawLocs = window.getAutoRouteLocations ? window.getAutoRouteLocations() : [];
    
    state.locations = rawLocs.map(loc => {
      const coords = GeoUtils.extractCoords(loc.originalInput || loc.input || loc.address) || {};
      const lat = loc.lat ?? loc.coords?.lat ?? coords.lat ?? null;
      const lng = loc.lng ?? loc.coords?.lng ?? coords.lng ?? null;
      
      const shouldAutoSelect = rawLocs.length > 0 && rawLocs.length <= 15;

      return {
        id: loc.id || `loc-${Math.random().toString(36).substr(2, 9)}`,
        name: loc.name || 'Local sem nome',
        address: loc.address || loc.originalInput || '',
        lat: lat !== null ? Number(lat) : null,
        lng: lng !== null ? Number(lng) : null,
        selected: shouldAutoSelect,
        priority: false,
        hasCoords: lat !== null,
        originalInput: loc.originalInput || loc.address || '',
        distFromUser: null
      };
    });

    state.sorted = [];
    state.phase = 'idle';
    state.totalKm = 0;
    state.usedOSRM = false;

    // UI Initial
    const driverSection = document.getElementById('arDriverSection');
    if (driverSection) {
      const role = window.userRole || '';
      (role === 'admin' || role === 'co-admin') 
        ? driverSection.classList.add('ar-visible') 
        : driverSection.classList.remove('ar-visible');
      if (role.includes('admin')) populateDriverSelect();
    }

    renderLocations();
    setPhase('idle');
    hideResult();
    
    const modal = document.getElementById('autoRouteModal');
    if (modal) modal.classList.add('active');

    // Tentar obter localização para ordenar a lista inicial
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        const uLat = pos.coords.latitude;
        const uLng = pos.coords.longitude;
        state.userCoords = { lat: uLat, lng: uLng };
        
        // Calcular distâncias e ordenar
        state.locations.forEach(loc => {
          if (loc.hasCoords) {
            loc.distFromUser = GeoUtils.haversine(uLat, uLng, loc.lat, loc.lng);
          }
        });

        // Ordenar: mais próximos primeiro
        state.locations.sort((a, b) => {
          if (a.distFromUser === null) return 1;
          if (b.distFromUser === null) return -1;
          return a.distFromUser - b.distFromUser;
        });

        renderLocations();
      }, err => console.warn('Não foi possível obter GPS para ordenação inicial:', err));
    }

    scheduleAutoCalc();
  };

  window.closeAutoRouteModal = function() {
    const modal = document.getElementById('autoRouteModal');
    if (modal) modal.classList.remove('active');
    if (state.autoTimer) clearTimeout(state.autoTimer);
  };

  function populateDriverSelect() {
    const sel = document.getElementById('arDriverSelect');
    if (!sel) return;
    const drivers = window._fleetDrivers || [];
    sel.innerHTML = drivers.length 
      ? drivers.map(d => `<option value="${d.uid}">${d.apelido || d.nome || d.email}</option>`).join('')
      : '<option value="">Nenhum motorista</option>';
    if (window._selectedDriverUid) sel.value = window._selectedDriverUid;
  }

  function renderLocations() {
    const list = document.getElementById('arLocList');
    const countEl = document.getElementById('arLocCount');
    if (!list) return;

    const query = (document.getElementById('arSearchInput')?.value || '').toLowerCase();
    const filtered = state.locations.filter(l => 
      l.name.toLowerCase().includes(query) || l.address.toLowerCase().includes(query)
    );

    const selCount = state.locations.filter(l => l.selected).length;
    if (countEl) countEl.textContent = `${selCount} selecionado${selCount !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      list.innerHTML = `<div class="ar-empty">Nenhum local encontrado</div>`;
      return;
    }

    list.innerHTML = filtered.map(loc => {
      const distLabel = loc.distFromUser !== null 
        ? `<span class="ar-loc-dist">📍 ${loc.distFromUser < 1 ? (loc.distFromUser * 1000).toFixed(0) + 'm' : loc.distFromUser.toFixed(1) + 'km'}</span>`
        : '';

      return `
        <div class="ar-loc-card ${loc.selected ? 'ar-selected' : ''} ${loc.priority ? 'ar-priority' : ''} ${!loc.hasCoords ? 'ar-no-coords' : ''}" 
             onclick="window._arToggleSelect('${loc.id}')">
          <div class="ar-loc-check">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
          </div>
          <div class="ar-loc-info">
            <div class="ar-loc-name">${escapeHTML(loc.name)}</div>
            <div class="ar-loc-addr">${loc.hasCoords ? escapeHTML(loc.address || '📍 Coordenadas OK') : '📡 Pendente de localização'}</div>
            ${distLabel}
          </div>
          <div class="ar-loc-star" onclick="event.stopPropagation(); window._arTogglePriority('${loc.id}')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
          </div>
        </div>
      `;
    }).join('');
  }

  function scheduleAutoCalc() {
    if (state.autoTimer) clearTimeout(state.autoTimer);
    if (state.locations.filter(l => l.selected).length === 0) return;
    state.autoTimer = setTimeout(() => window._arCalculate(), CONFIG.AUTO_CALC_DELAY);
  }

  window._arToggleSelect = function(id) {
    const loc = state.locations.find(l => String(l.id) === String(id));
    if (!loc) return;
    loc.selected = !loc.selected;
    if (!loc.selected) loc.priority = false;
    renderLocations();
    hideResult();
    scheduleAutoCalc();
  };

  window._arTogglePriority = function(id) {
    const loc = state.locations.find(l => String(l.id) === String(id));
    if (!loc) return;
    loc.selected = true;
    loc.priority = !loc.priority;
    renderLocations();
    hideResult();
    scheduleAutoCalc();
  };

  window._arSelectAll = () => { state.locations.forEach(l => l.selected = true); renderLocations(); hideResult(); scheduleAutoCalc(); };
  window._arDeselectAll = () => { state.locations.forEach(l => { l.selected = false; l.priority = false; }); renderLocations(); hideResult(); };
  window._arFilterLocs = () => renderLocations();

  function setPhase(phase, text) {
    state.phase = phase;
    const bar = document.getElementById('arStatusBar');
    const statusText = document.getElementById('arStatusText');
    const spinner = document.getElementById('arSpinner');
    const check = document.getElementById('arStatusCheck');
    
    if (!bar) return;
    if (phase === 'idle') { bar.classList.remove('ar-visible'); return; }
    
    bar.classList.add('ar-visible');
    if (statusText) statusText.textContent = text || '';
    
    if (phase === 'ready') {
      if (spinner) spinner.style.display = 'none';
      if (check) check.style.display = 'flex';
    } else {
      if (spinner) spinner.style.display = 'block';
      if (check) check.style.display = 'none';
    }
  }

  function hideResult() {
    const res = document.getElementById('arResultSection');
    if (res) res.classList.remove('ar-visible');
    const confirmBtn = document.getElementById('arConfirmBtn');
    if (confirmBtn) confirmBtn.style.display = 'none';
    const calcBtn = document.getElementById('arCalcBtn');
    if (calcBtn) {
      calcBtn.style.display = 'flex';
      calcBtn.disabled = false;
      calcBtn.innerHTML = '🧠 Calcular Melhor Rota';
    }
  }

  // ── CORE: CÁLCULO DA ROTA ──
  window._arCalculate = async function() {
    const selected = state.locations.filter(l => l.selected);
    if (selected.length === 0) return;

    const calcBtn = document.getElementById('arCalcBtn');
    if (calcBtn) {
      calcBtn.disabled = true;
      calcBtn.innerHTML = '<div class="ar-spinner" style="width:14px;height:14px;border-width:2px;"></div> Calculando...';
    }

    try {
      // 1. Obter Localização do Usuário
      setPhase('locating', 'Obtendo GPS...');
      let uLat = state.userCoords?.lat ?? null;
      let uLng = state.userCoords?.lng ?? null;

      try {
        if (navigator.geolocation) {
          const pos = await new Promise((res, rej) => {
            navigator.geolocation.getCurrentPosition(res, rej, { 
              enableHighAccuracy: true, 
              timeout: 4000 
            });
          });
          uLat = pos.coords.latitude;
          uLng = pos.coords.longitude;
          state.userCoords = { lat: uLat, lng: uLng }; // Update cache
        }
      } catch (err) {
        console.warn('Geolocation imediata falhou, usando cache ou fallback:', err);
        // Já inicializamos com state.userCoords, então apenas continua
        if (uLat === null && window.userCoords) {
           uLat = window.userCoords.lat;
           uLng = window.userCoords.lng;
        }
      }

      // 2. Extração Robusta de Coordenadas (Híbrida: Local + API)
      setPhase('resolving', 'Processando localizações...');
      for (const loc of selected) {
        if (!loc.hasCoords) {
          // Tenta resolver usando a nova Bridge API do app.js
          const resolved = window.resolveLocationCoords ? await window.resolveLocationCoords(loc.originalInput) : GeoUtils.extractCoords(loc.originalInput);
          if (resolved) { 
            loc.lat = resolved.lat; 
            loc.lng = resolved.lng; 
            loc.hasCoords = true; 
          }
        }
      }

      // 3. Otimização (Apenas Frontend para estabilidade total conforme solicitado)
      // O usuário pediu "somente no frontend" para evitar erros locais de servidor.
      setPhase('resolving', 'Ordenando paradas...');
      
      // Simulação de processamento para UX
      await new Promise(r => setTimeout(r, 600));

      const sorted = RouteEngine.solve(uLat, uLng, selected);
      
      // Calcular distâncias acumuladas
      let totalKm = 0;
      let prevLat = uLat;
      let prevLng = uLng;

      const finalSorted = sorted.map(pt => {
        let d = null;
        if (pt.lat !== null && prevLat !== null) {
          d = GeoUtils.haversine(prevLat, prevLng, pt.lat, pt.lng);
          totalKm += d;
          prevLat = pt.lat;
          prevLng = pt.lng;
        }
        return { ...pt, distFromPrevKm: d };
      });

      state.sorted = finalSorted;
      state.totalKm = totalKm;
      state.usedOSRM = false;

      setPhase('ready', 'Rota otimizada!');
      renderResult();
      
      if (calcBtn) calcBtn.style.display = 'none';
      const confirmBtn = document.getElementById('arConfirmBtn');
      if (confirmBtn) confirmBtn.style.display = 'flex';

    } catch (err) {
      console.error('Erro no Auto-Route:', err);
      window.showToast('Erro ao calcular rota.', 'error');
      setPhase('idle');
      if (calcBtn) {
        calcBtn.disabled = false;
        calcBtn.innerHTML = '🧠 Calcular Melhor Rota';
      }
    }
  };

  function renderResult() {
    const listEl = document.getElementById('arResultList');
    if (!listEl) return;

    document.getElementById('arStatKm').textContent = state.totalKm.toFixed(1);
    document.getElementById('arStatStops').textContent = state.sorted.length;
    document.getElementById('arStatPriority').textContent = state.sorted.filter(p => p.priority).length;

    listEl.innerHTML = state.sorted.map((pt, i) => `
      <div class="ar-result-item ${pt.priority ? 'ar-result-priority' : ''} ${!pt.hasCoords ? 'ar-result-nogps' : ''}">
        <div class="ar-result-badge">${i + 1}</div>
        <div class="ar-result-info">
          <div class="ar-result-name">${escapeHTML(pt.name)}</div>
          <div class="ar-result-tags">
            ${pt.priority ? '<span class="ar-result-tag ar-tag-priority">⚡ PRIORIDADE</span>' : ''}
            ${!pt.hasCoords ? '<span class="ar-result-tag ar-tag-nogps">📡 Sem GPS</span>' : ''}
            ${pt.distFromPrevKm !== null ? `<span class="ar-result-dist">${pt.distFromPrevKm < 1 ? (pt.distFromPrevKm * 1000).toFixed(0) + ' m' : pt.distFromPrevKm.toFixed(1) + ' km'}</span>` : ''}
          </div>
        </div>
      </div>
    `).join('');

    const res = document.getElementById('arResultSection');
    if (res) res.classList.add('ar-visible');
  }

  window._arConfirmRoute = function() {
    if (state.sorted.length === 0) return;
    setPhase('ready', 'Enviando para a agenda...');
    
    // Configura motorista se admin
    const role = window.userRole || '';
    if (role.includes('admin')) {
      const sel = document.getElementById('arDriverSelect');
      if (sel?.value) {
        window._selectedDriverUid = sel.value;
        if (window.selectBuilderDriver) window.selectBuilderDriver(sel.value);
      }
    }

    const points = state.sorted.map(pt => ({
      id: pt.id,
      name: pt.name,
      lat: pt.lat,
      lng: pt.lng,
      originalInput: pt.originalInput || pt.address,
      input: pt.originalInput || pt.address
    }));

    if (window.setBuilderPointsAndGenerate) {
      window.setBuilderPointsAndGenerate(points);
      setTimeout(() => window.closeAutoRouteModal(), 500);
    } else {
      window.showToast('Erro ao injetar rota no sistema principal.', 'error');
    }
  };

  function escapeHTML(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

})();
