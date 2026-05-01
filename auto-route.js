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
  let arLocations  = [];
  let arSorted     = [];
  let arPhase      = 'idle';
  let arTotalKm    = 0;

  // ── Haversine distance (km) ──
  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Nearest Neighbor sort ──
  function nearestNeighborSort(startLat, startLng, points) {
    if (points.length === 0) return [];
    const remaining = [...points];
    const sorted = [];
    
    let curLat = startLat, curLng = startLng;

    // Se não tiver GPS de origem (usuário sem permissão), usa o 1º item da lista
    if (curLat == null || curLng == null) {
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
    return sorted;
  }

  // ── Calculate total route distance ──
  function calcTotalKm(origin, points) {
    let total = 0;
    // Se a origem for nula (sem GPS), pegamos o primeiro ponto válido
    let prev = (origin.lat != null && origin.lng != null) ? origin : null;
    
    for (const pt of points) {
      if (pt.lat != null && pt.lng != null) {
        if (prev != null && prev.lat != null && prev.lng != null) {
          total += haversine(prev.lat, prev.lng, pt.lat, pt.lng);
        }
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
        selected: false,
        priority: false,
        hasCoords: hasCoords,
        resolving: false,
        resolveFailed: false
      };
    });

    arSorted = [];
    arPhase = 'idle';
    arTotalKm = 0;

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
      opt.textContent = d.displayName || d.name || d.email || d.uid;
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
        ? (loc.address ? escapeHTML(truncate(loc.address, 50)) : '📍 Coordenadas disponíveis')
        : `<span class="ar-loc-no-gps">📡 Coordenadas serão resolvidas ao calcular</span>`;

      const safeId = String(loc.id).replace(/'/g, "\\'");

      return `
        <div class="${classes.join(' ')}" data-id="${loc.id}" onclick="window._arToggleSelect('${safeId}')">
          <div class="ar-loc-check">✓</div>
          <div class="ar-loc-info">
            <div class="ar-loc-name">${escapeHTML(loc.name)}</div>
            <div class="ar-loc-addr">${statusText}</div>
          </div>
          <div class="ar-loc-star" onclick="event.stopPropagation(); window._arTogglePriority('${safeId}')" title="Marcar como prioridade">⭐</div>
        </div>`;
    }).join('');
  }

  // ── Toggle Selection ──
  window._arToggleSelect = function(id) {
    const loc = arLocations.find(l => String(l.id) === String(id));
    if (!loc) return;
    loc.selected = !loc.selected;
    if (!loc.selected) loc.priority = false;
    renderLocations(document.getElementById('arSearchInput')?.value);
    hideResult();
  };

  // ── Toggle Priority (any location) ──
  window._arTogglePriority = function(id) {
    const loc = arLocations.find(l => String(l.id) === String(id));
    if (!loc) return;
    if (!loc.selected) loc.selected = true;
    loc.priority = !loc.priority;
    renderLocations(document.getElementById('arSearchInput')?.value);
    hideResult();
  };

  // ── Select All / Deselect All ──
  window._arSelectAll = function() {
    arLocations.forEach(l => l.selected = true);
    renderLocations(document.getElementById('arSearchInput')?.value);
    hideResult();
  };

  window._arDeselectAll = function() {
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
  //  CALCULATE — Core pipeline (senior-level)
  // ══════════════════════════════════════════════════════════
  window._arCalculate = async function() {
    const selected = arLocations.filter(l => l.selected);
    if (selected.length === 0) {
      window.showToast('Selecione pelo menos um local para calcular.', 'warning');
      return;
    }

    const calcBtn = document.getElementById('arCalcBtn');
    if (calcBtn) {
      calcBtn.disabled = true;
      calcBtn.innerHTML = '<div class="ar-spinner" style="width:16px;height:16px;border-width:2px;"></div> Calculando...';
    }

    // ── Phase 1: Get user GPS ──
    setPhase('locating', 'Obtendo sua localização GPS...');

    let userLat = null, userLng = null;
    try {
      const pos = await new Promise((resolve, reject) => {
        if (!('geolocation' in navigator)) {
          reject(new Error('GPS não suportado'));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 8000, // Reduced to 8s to fallback faster if stuck
          maximumAge: 60000
        });
      });
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
      // Atualiza o global para uso futuro
      window.userCoords = { lat: userLat, lng: userLng };
    } catch (e) {
      if (window.userCoords && window.userCoords.lat) {
        userLat = window.userCoords.lat;
        userLng = window.userCoords.lng;
      } else {
        // Fallback avançado: Geolocalização via IP
        try {
          const ipRes = await fetch('https://ipapi.co/json/');
          if (ipRes.ok) {
            const ipData = await ipRes.json();
            if (ipData.latitude && ipData.longitude) {
              userLat = Number(ipData.latitude);
              userLng = Number(ipData.longitude);
              window.userCoords = { lat: userLat, lng: userLng };
              window.showToast('GPS bloqueado. Usando localização aproximada via rede.', 'info');
            }
          }
        } catch (errIp) {
          window.showToast('Não foi possível obter sua localização. A rota começará do primeiro local.', 'warning');
        }
      }
    }

    // ── Phase 2: Resolve coordinates for locations without lat/lng ──
    const needsResolving = selected.filter(l => !l.hasCoords && l.address);
    
    if (needsResolving.length > 0) {
      setPhase('resolving', `Resolvendo coordenadas de ${needsResolving.length} local(is)...`);

      // Resolve in parallel (batched to avoid overwhelming the backend)
      const BATCH_SIZE = 5;
      for (let i = 0; i < needsResolving.length; i += BATCH_SIZE) {
        const batch = needsResolving.slice(i, i + BATCH_SIZE);
        
        const results = await Promise.allSettled(
          batch.map(async loc => {
            if (!window.resolveLocationCoords) return null;
            const resolved = await window.resolveLocationCoords(loc.address);
            return { id: loc.id, resolved };
          })
        );

        // Apply resolved coordinates back
        results.forEach(result => {
          if (result.status === 'fulfilled' && result.value?.resolved) {
            const { id, resolved } = result.value;
            const loc = arLocations.find(l => l.id === id);
            if (loc && resolved.lat && resolved.lng) {
              loc.lat = resolved.lat;
              loc.lng = resolved.lng;
              loc.hasCoords = true;
              if (resolved.name && loc.name === 'Local sem nome') {
                loc.name = resolved.name;
              }
            }
          }
        });

        // Update progress text
        const done = Math.min(i + BATCH_SIZE, needsResolving.length);
        setPhase('resolving', `Resolvendo coordenadas... (${done}/${needsResolving.length})`);
      }
    }

    // ── Phase 3: Nearest Neighbor sort ──
    setPhase('resolving', 'Calculando rota inteligente...');
    await sleep(300);

    // Separate resolved vs unresolved
    const resolved   = selected.filter(l => l.hasCoords);
    const unresolved = selected.filter(l => !l.hasCoords);

    // Among resolved: priority vs normal
    const priorityWithCoords = resolved.filter(l => l.priority);
    const normalWithCoords   = resolved.filter(l => !l.priority);

    // Nearest Neighbor: priority first from user position
    const sortedPriority = nearestNeighborSort(userLat, userLng, priorityWithCoords);

    // Chain position: continue from last priority (or user pos)
    let chainLat = userLat, chainLng = userLng;
    if (sortedPriority.length > 0) {
      const last = sortedPriority[sortedPriority.length - 1];
      chainLat = last.lat;
      chainLng = last.lng;
    }

    // Normal: sorted from chain position
    const sortedNormal = nearestNeighborSort(chainLat, chainLng, normalWithCoords);

    // Unresolved priority first, then unresolved normal, appended at end
    const unresolvedPriority = unresolved.filter(l => l.priority);
    const unresolvedNormal   = unresolved.filter(l => !l.priority);

    // Final order: Priority(GPS) → Normal(GPS) → Priority(no GPS) → Normal(no GPS)
    arSorted = [...sortedPriority, ...sortedNormal, ...unresolvedPriority, ...unresolvedNormal];
    arTotalKm = calcTotalKm({ lat: userLat, lng: userLng }, arSorted);

    // ── Phase 4: Ready ──
    if (unresolved.length > 0) {
      setPhase('ready', `Rota calculada! (${unresolved.length} local(is) sem GPS, adicionados ao final)`);
    } else {
      setPhase('ready', 'Rota calculada com sucesso!');
    }

    renderResult();

    if (calcBtn) calcBtn.style.display = 'none';
    const confirmBtn = document.getElementById('arConfirmBtn');
    if (confirmBtn) confirmBtn.style.display = 'flex';
  };

  // ── Render Result ──
  function renderResult() {
    const section = document.getElementById('arResultSection');
    const listEl  = document.getElementById('arResultList');
    const kmEl    = document.getElementById('arStatKm');
    const stopsEl = document.getElementById('arStatStops');
    const prioEl  = document.getElementById('arStatPriority');

    if (!section || !listEl) return;

    kmEl.textContent = arTotalKm.toFixed(1);
    stopsEl.textContent = arSorted.length;
    prioEl.textContent = arSorted.filter(p => p.priority).length;

    listEl.innerHTML = arSorted.map((pt, i) => {
      const isPrio = pt.priority;
      const noGps = !pt.hasCoords;
      const classes = ['ar-result-item'];
      if (isPrio) classes.push('ar-result-priority');
      if (noGps) classes.push('ar-result-nogps');

      return `
        <div class="${classes.join(' ')}">
          <div class="ar-result-badge">${i + 1}</div>
          <div class="ar-result-name">${escapeHTML(pt.name)}</div>
          ${isPrio ? '<span class="ar-result-tag ar-tag-priority">⭐ PRIORIDADE</span>' : ''}
          ${noGps ? '<span class="ar-result-tag ar-tag-nogps">📡 Sem GPS</span>' : ''}
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
