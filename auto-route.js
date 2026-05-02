/**
 * ══════════════════════════════════════════════════════════
 *  AUTO-ROUTE — Rota Automática Inteligente (Nearest Neighbor)
 *  Arquivo standalone, comunica com app.js via window.*
 *
 *  Pipeline:
 *  1. Carrega TODOS os locais da agenda (com ou sem coordenadas)
 *  2. Ao calcular, resolve coordenadas em paralelo via:
 *     - extractCoordsFromUrl (client-side, instantâneo)
 *     - /api/resolve (backend, para short-links tipo goo.gl)
 *  3. Ordena via Nearest Neighbor (prioridades sempre na frente)
 *  4. Injeta no builder e gera a rota via generateManualRoute
 * ══════════════════════════════════════════════════════════
 */
(function() {
  'use strict';

  // ── State ──
  let arLocations   = [];
  let arSorted      = [];
  let arPhase       = 'idle';
  let arTotalKm     = 0;
  let arAutoTimer   = null; // debounce handle for auto-recalculate
  let arUsedOSRM    = false; // flag: tells user if real-road distances were used

  // ── Haversine distance (km) ──
  // BUG FIX: Added NaN guard — returns Infinity if any coordinate is invalid,
  // so it's never chosen as "nearest" in the sort algorithm.
  function haversine(lat1, lng1, lat2, lng2) {
    if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return Infinity;
    if (isNaN(lat1) || isNaN(lng1) || isNaN(lat2) || isNaN(lng2)) return Infinity;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Nearest Neighbor sort ──
  // BUG FIX: Pre-filters points with invalid coords before sorting to prevent
  // NaN comparisons that would corrupt the route order. Invalid points are
  // returned at the end (unrouted), not silently dropped.
  function nearestNeighborSort(startLat, startLng, points) {
    if (points.length === 0) return [];

    // Separate valid from invalid coordinate points
    const validPoints   = points.filter(p => p.lat != null && p.lng != null && !isNaN(p.lat) && !isNaN(p.lng));
    const invalidPoints = points.filter(p => !(p.lat != null && p.lng != null && !isNaN(p.lat) && !isNaN(p.lng)));

    const remaining = [...validPoints];
    const sorted = [];
    
    let curLat = startLat, curLng = startLng;

    // Se não tiver GPS de origem válida, usa o 1º ponto válido como âncora
    if (curLat == null || curLng == null || isNaN(curLat) || isNaN(curLng)) {
      if (remaining.length === 0) return [...invalidPoints];
      const first = remaining.shift();
      sorted.push(first);
      curLat = first.lat;
      curLng = first.lng;
    }

    while (remaining.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = haversine(curLat, curLng, remaining[i].lat, remaining[i].lng);
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = i;
        }
      }
      const chosen = remaining.splice(nearestIdx, 1)[0];
      sorted.push(chosen);
      curLat = chosen.lat;
      curLng = chosen.lng;
    }

    // Append invalid-coord points at the end (same behavior as before, explicit now)
    return [...sorted, ...invalidPoints];
  }

  // ── OSRM Distance Matrix (free, no API key needed) ──
  // Uses the public OSRM routing engine to get real road distances.
  // Falls back to Haversine silently if unavailable.
  async function fetchOSRMMatrix(coordsList) {
    if (!coordsList || coordsList.length < 2) return null;
    if (coordsList.length > 25) return null; // public API limit
    const coords = coordsList.map(c => `${c.lng},${c.lat}`).join(';');
    const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=distance`;
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(tid);
      if (!res.ok) return null;
      const data = await res.json();
      if (data.code !== 'Ok' || !data.distances) return null;
      return data.distances; // NxN matrix in meters
    } catch (e) {
      console.warn('[Auto-Route] OSRM indisponível, usando Haversine:', e.message);
      return null;
    }
  }

  // ── Nearest Neighbor using OSRM matrix (index-based) ──
  function nnMatrix(startIdx, candidates, matrix, coordsList) {
    const valid   = candidates.filter(p => p._mi != null);
    const invalid = candidates.filter(p => p._mi == null);
    const remaining = [...valid];
    const sorted = [];
    let curIdx = startIdx;

    if (curIdx == null) {
      if (remaining.length === 0) return invalid;
      const first = remaining.shift();
      sorted.push(first);
      curIdx = first._mi;
    }

    while (remaining.length > 0) {
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        let d;
        if (matrix && matrix[curIdx] && remaining[i]._mi != null) {
          d = matrix[curIdx][remaining[i]._mi] ?? Infinity;
        } else {
          const from = coordsList[curIdx];
          d = haversine(from.lat, from.lng, remaining[i].lat, remaining[i].lng) * 1000;
        }
        if (d < bestDist) { bestDist = d; best = i; }
      }
      const chosen = remaining.splice(best, 1)[0];
      sorted.push(chosen);
      curIdx = chosen._mi;
    }
    return [...sorted, ...invalid];
  }

  // ── Calculate total route distance (km) ──
  function calcTotalKm(origin, points) {
    let total = 0;
    let prev = (origin.lat != null && origin.lng != null) ? origin : null;
    for (const pt of points) {
      if (pt.lat != null && pt.lng != null && !isNaN(pt.lat) && !isNaN(pt.lng)) {
        if (prev != null) total += haversine(prev.lat, prev.lng, pt.lat, pt.lng);
        prev = pt;
      }
    }
    return total;
  }

  // ── Open Modal ──
  window.openAutoRouteModal = function() {
    if (window.closeRouteChoiceModal) window.closeRouteChoiceModal();

    const rawLocs = window.getAutoRouteLocations ? window.getAutoRouteLocations() : [];

    arLocations = rawLocs.map(loc => {
      const lat = loc.lat ?? loc.coords?.lat ?? null;
      const lng = loc.lng ?? loc.coords?.lng ?? null;
      const hasCoords = lat != null && lng != null;
      return {
        id: loc.id || loc.name || ('loc-' + Math.random().toString(36).substr(2, 6)),
        name: loc.name || 'Local sem nome',
        address: loc.originalInput || loc.input || loc.address || '',
        lat: hasCoords ? Number(lat) : null,
        lng: hasCoords ? Number(lng) : null,
        originalInput: loc.originalInput || loc.input || '',
        selected: true,  // ← AUTO-SELECT ALL on open
        priority: false,
        hasCoords: hasCoords,
        resolving: false,
        resolveFailed: false
      };
    });

    arSorted = [];
    arPhase = 'idle';
    arTotalKm = 0;
    arUsedOSRM = false;
    if (arAutoTimer) clearTimeout(arAutoTimer);

    // Driver selector
    const driverSection = document.getElementById('arDriverSection');
    const role = window.userRole || '';
    if (driverSection) {
      if (role === 'admin' || role === 'co-admin') {
        driverSection.classList.add('ar-visible');
        populateDriverSelect();
      } else {
        driverSection.classList.remove('ar-visible');
      }
    }

    renderLocations();
    hideResult();
    setPhase('idle');

    const modal = document.getElementById('autoRouteModal');
    if (modal) modal.classList.add('active');

    // ── AUTO-CALCULATE: start 1.2s after modal opens ──
    scheduleAutoCalc();
  };

  window.closeAutoRouteModal = function() {
    const modal = document.getElementById('autoRouteModal');
    if (modal) modal.classList.remove('active');
    arPhase = 'idle';
  };

  // ── Driver Select ──
  function populateDriverSelect() {
    const sel = document.getElementById('arDriverSelect');
    if (!sel) return;
    sel.innerHTML = '';

    const drivers = window._fleetDrivers || [];
    if (drivers.length === 0) {
      sel.innerHTML = '<option value="">Nenhum motorista disponível</option>';
      return;
    }

    drivers.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.uid;
      opt.textContent = d.apelido || d.nome || d.displayName || d.name || d.email || d.uid;
      sel.appendChild(opt);
    });

    if (window._selectedDriverUid) sel.value = window._selectedDriverUid;
  }

  // ── Render Locations ──
  function renderLocations(filter) {
    const list = document.getElementById('arLocList');
    const countEl = document.getElementById('arLocCount');
    if (!list) return;

    const query = (filter || '').toLowerCase().trim();
    const filtered = query
      ? arLocations.filter(l => l.name.toLowerCase().includes(query) || l.address.toLowerCase().includes(query))
      : arLocations;

    const selectedCount = arLocations.filter(l => l.selected).length;
    countEl.textContent = `${selectedCount} selecionado${selectedCount !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      list.innerHTML = `
        <div class="ar-empty">
          <div class="ar-empty-icon">📍</div>
          <div class="ar-empty-text">${query ? 'Nenhum local encontrado' : 'Nenhum local cadastrado na sua agenda'}</div>
        </div>`;
      return;
    }

    list.innerHTML = filtered.map(loc => {
      const classes = ['ar-loc-card'];
      if (loc.selected) classes.push('ar-selected');
      if (loc.priority) classes.push('ar-priority');
      if (!loc.hasCoords) classes.push('ar-no-coords');

      const statusText = loc.hasCoords
        ? (loc.address ? escapeHTML(loc.address) : '📍 Coordenadas disponíveis')
        : `<span class="ar-loc-no-gps">📡 Coordenadas serão resolvidas ao calcular</span>`;

      const safeId = String(loc.id).replace(/'/g, "\\'");

      return `
        <div class="${classes.join(' ')}" data-id="${loc.id}" onclick="window._arToggleSelect('${safeId}')">
          <div class="ar-loc-check">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </div>
          <div class="ar-loc-info">
            <div class="ar-loc-name">${escapeHTML(loc.name)}</div>
            <div class="ar-loc-addr">${statusText}</div>
          </div>
          <div class="ar-loc-star" onclick="event.stopPropagation(); window._arTogglePriority('${safeId}')" title="Marcar como prioridade">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
          </div>
        </div>`;
    }).join('');
  }

  // ── scheduleAutoCalc: debounced auto-trigger ──
  // Called on open and after any selection/priority change.
  // Waits 1.2s idle before firing so rapid clicks batch into one calculation.
  function scheduleAutoCalc(delay) {
    if (arAutoTimer) clearTimeout(arAutoTimer);
    const selected = arLocations.filter(l => l.selected);
    if (selected.length === 0) return;
    arAutoTimer = setTimeout(() => {
      arAutoTimer = null;
      window._arCalculate();
    }, delay ?? 1200);
  }

  // ── Toggle Selection ──
  window._arToggleSelect = function(id) {
    const loc = arLocations.find(l => String(l.id) === String(id));
    if (!loc) return;
    loc.selected = !loc.selected;
    if (!loc.selected) loc.priority = false;
    renderLocations(document.getElementById('arSearchInput')?.value);
    hideResult();
    scheduleAutoCalc();
  };

  // ── Toggle Priority (any location) ──
  window._arTogglePriority = function(id) {
    const loc = arLocations.find(l => String(l.id) === String(id));
    if (!loc) return;
    if (!loc.selected) loc.selected = true;
    loc.priority = !loc.priority;
    renderLocations(document.getElementById('arSearchInput')?.value);
    hideResult();
    scheduleAutoCalc();
  };

  // ── Select All / Deselect All ──
  window._arSelectAll = function() {
    arLocations.forEach(l => l.selected = true);
    renderLocations(document.getElementById('arSearchInput')?.value);
    hideResult();
    scheduleAutoCalc();
  };

  window._arDeselectAll = function() {
    if (arAutoTimer) clearTimeout(arAutoTimer);
    arLocations.forEach(l => { l.selected = false; l.priority = false; });
    renderLocations(document.getElementById('arSearchInput')?.value);
    hideResult();
  };

  window._arFilterLocs = function() {
    renderLocations(document.getElementById('arSearchInput')?.value || '');
  };

  // ── UI Helpers ──
  function hideResult() {
    const el = document.getElementById('arResultSection');
    if (el) el.classList.remove('ar-visible');
    const confirmBtn = document.getElementById('arConfirmBtn');
    if (confirmBtn) confirmBtn.style.display = 'none';
    const calcBtn = document.getElementById('arCalcBtn');
    if (calcBtn) {
      calcBtn.style.display = 'flex';
      calcBtn.disabled = false;
      calcBtn.innerHTML = '🧠 Calcular Melhor Rota';
    }
  }

  function setPhase(phase, text) {
    arPhase = phase;
    const bar = document.getElementById('arStatusBar');
    const spinner = document.getElementById('arSpinner');
    const statusText = document.getElementById('arStatusText');
    const check = document.getElementById('arStatusCheck');

    if (!bar) return;

    if (phase === 'idle') {
      bar.classList.remove('ar-visible');
      return;
    }

    bar.classList.add('ar-visible');
    statusText.textContent = text || '';

    if (phase === 'ready') {
      spinner.style.display = 'none';
      check.style.display = 'flex';
    } else {
      spinner.style.display = 'block';
      check.style.display = 'none';
    }
  }

  // ══════════════════════════════════════════════════════════
  //  CALCULATE — Delega tudo ao backend /api/optimize-route
  //  O backend faz: resolve links → OSRM matrix → Nearest Neighbor
  //  O frontend só envia os locais + GPS do usuário e renderiza.
  // ══════════════════════════════════════════════════════════
  window._arCalculate = async function() {
    const selected = arLocations.filter(l => l.selected);
    if (selected.length === 0) {
      window.showToast('Selecione pelo menos um local para calcular.', 'warning');
      return;
    }

    const calcBtn = document.getElementById('arCalcBtn');

    const resetUI = (errorMsg) => {
      setPhase('idle');
      if (calcBtn) {
        calcBtn.disabled = false;
        calcBtn.style.display = 'flex';
        calcBtn.innerHTML = '🧠 Calcular Melhor Rota';
      }
      if (errorMsg) {
        console.error('[Auto-Route] Pipeline error:', errorMsg);
        window.showToast('Erro ao calcular rota. Tente novamente.', 'error');
      }
    };

    if (calcBtn) {
      calcBtn.disabled = true;
      calcBtn.innerHTML = '<div class="ar-spinner" style="width:16px;height:16px;border-width:2px;"></div> Calculando...';
    }

    try {

    // ── Passo 1: Obter GPS do usuário ──────────────────────────────────────
    setPhase('locating', 'Obtendo sua localização GPS...');

    let userLat = null, userLng = null;
    try {
      const pos = await new Promise((resolve, reject) => {
        if (!('geolocation' in navigator)) { reject(new Error('GPS não suportado')); return; }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true, timeout: 8000, maximumAge: 60000
        });
      });
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
      window.userCoords = { lat: userLat, lng: userLng };
    } catch (_gpsErr) {
      // Fallback 1: GPS salvo de sessão anterior
      if (window.userCoords?.lat) {
        userLat = window.userCoords.lat;
        userLng = window.userCoords.lng;
      } else {
        // Fallback 2: Geolocalização por IP (sem precisão perfeita mas funcional)
        try {
          const ipRes = await fetch('https://ipapi.co/json/');
          if (ipRes.ok) {
            const ipData = await ipRes.json();
            if (ipData.latitude && ipData.longitude) {
              userLat = Number(ipData.latitude);
              userLng = Number(ipData.longitude);
              window.userCoords = { lat: userLat, lng: userLng };
              window.showToast('GPS bloqueado. Usando localização aproximada por rede.', 'info');
            }
          }
        } catch (_ipErr) {
          window.showToast('Localização não disponível. Rota começará do primeiro local.', 'warning');
        }
      }
    }

    // ── Passo 2: Montar payload e enviar ao backend ─────────────────────────
    setPhase('resolving', 'Resolvendo endereços e calculando rota no servidor...');

    const token = await (window.getAuthToken ? window.getAuthToken() : null);

    const payload = {
      userLat,
      userLng,
      locations: selected.map(loc => ({
        id: loc.id,
        name: loc.name,
        address: loc.address || loc.originalInput || '',
        lat: loc.hasCoords ? loc.lat : null,
        lng: loc.hasCoords ? loc.lng : null,
        priority: !!loc.priority
      }))
    };

    setPhase('resolving', 'Consultando distâncias reais via OSRM...');

    const API_URL = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || window.location.protocol === "file:" || !window.location.hostname)
      ? "http://localhost:3000"
      : "https://seu-backend-producao.com"; // Deve refletir a config global

    const response = await fetch(`${API_URL}/api/optimize-route`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${response.status}`);
    }

    const result = await response.json();
    // result = { sorted, totalKm, usedOSRM, unresolved }

    // ── Passo 3: Salvar resultado e atualizar estado ─────────────────────────
    arSorted   = result.sorted || [];
    arTotalKm  = result.totalKm ?? 0;
    arUsedOSRM = result.usedOSRM ?? false;

    // Sincroniza dados resolvidos de volta para arLocations (para re-cálculos)
    arSorted.forEach(srv => {
      const loc = arLocations.find(l => String(l.id) === String(srv.id));
      if (loc && srv.lat != null && srv.lng != null) {
        loc.lat = srv.lat;
        loc.lng = srv.lng;
        loc.hasCoords = true;
      }
    });

    // ── Passo 4: Mostrar resultado ──────────────────────────────────────────
    const distLabel = arUsedOSRM ? ' (distâncias reais de estrada)' : ' (distâncias em linha reta)';
    const unresolvedCount = (result.unresolved || []).length;

    if (unresolvedCount > 0) {
      setPhase('ready', `Rota calculada!${distLabel} · ${unresolvedCount} local(is) sem GPS ao final.`);
    } else {
      setPhase('ready', `Rota calculada com sucesso!${distLabel}`);
    }

    renderResult();

    if (calcBtn) calcBtn.style.display = 'none';
    const confirmBtn = document.getElementById('arConfirmBtn');
    if (confirmBtn) confirmBtn.style.display = 'flex';

    } catch (pipelineError) {
      resetUI(pipelineError);
    }
  }; // <--- FECHA O _arCalculate AQUI


  // ── Render Result ──
  // Exibe a rota ordenada com distâncias por parada (vindas do backend)
  function renderResult() {
    const section = document.getElementById('arResultSection');
    const listEl  = document.getElementById('arResultList');
    const kmEl    = document.getElementById('arStatKm');
    const stopsEl = document.getElementById('arStatStops');
    const prioEl  = document.getElementById('arStatPriority');

    if (!section || !listEl || !kmEl || !stopsEl || !prioEl) {
      console.warn('[Auto-Route] renderResult: elemento DOM não encontrado.');
      return;
    }

    kmEl.textContent    = isNaN(arTotalKm) ? '0.0' : Number(arTotalKm).toFixed(1);
    stopsEl.textContent = arSorted.length;
    prioEl.textContent  = arSorted.filter(p => p.priority).length;

    listEl.innerHTML = arSorted.map((pt, i) => {
      const isPrio  = pt.priority;
      const noGps   = pt.hasCoords === false;
      const distKm  = typeof pt.distFromPrevKm === 'number' ? pt.distFromPrevKm : null;
      const classes = ['ar-result-item'];
      if (isPrio) classes.push('ar-result-priority');
      if (noGps)  classes.push('ar-result-nogps');

      const distBadge = distKm != null
        ? `<span class="ar-result-dist">${distKm < 1 ? (distKm * 1000).toFixed(0) + ' m' : distKm.toFixed(1) + ' km'}</span>`
        : '';

      return `
        <div class="${classes.join(' ')}">
          <div class="ar-result-badge">${i + 1}</div>
          <div class="ar-result-info">
            <div class="ar-result-name">${escapeHTML(pt.name)}</div>
            <div class="ar-result-tags">
              ${isPrio ? '<span class="ar-result-tag ar-tag-priority">⚡ PRIORIDADE</span>' : ''}
              ${noGps  ? '<span class="ar-result-tag ar-tag-nogps">📡 Sem GPS</span>' : ''}
              ${distBadge}
            </div>
          </div>
        </div>`;
    }).join('');

    section.classList.add('ar-visible');
  }


  // ── CONFIRM — inject and generate ──
  window._arConfirmRoute = function() {
    if (arSorted.length === 0) return;

    setPhase('sending', 'Enviando rota ao motorista...');

    // Set driver if admin
    const role = window.userRole || '';
    if (role === 'admin' || role === 'co-admin') {
      const sel = document.getElementById('arDriverSelect');
      if (sel && sel.value) {
        window._selectedDriverUid = sel.value;
        if (window.selectBuilderDriver) window.selectBuilderDriver(sel.value);
      }
    }

    // Convert sorted points
    const points = arSorted.map(pt => ({
      id: pt.id,
      name: pt.name,
      lat: pt.lat,
      lng: pt.lng,
      originalInput: pt.originalInput || pt.address || '',
      input: pt.originalInput || pt.address || ''
    }));

    if (window.setBuilderPointsAndGenerate) {
      window.setBuilderPointsAndGenerate(points);
    } else {
      window.showToast('Erro interno: bridge não encontrada.', 'error');
      setPhase('idle');
      return;
    }

    setTimeout(() => window.closeAutoRouteModal(), 800);
  };

  // ── Helpers ──
  function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function truncate(str, max) {
    if (!str || str.length <= max) return str || '';
    return str.substring(0, max) + '…';
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

})();
