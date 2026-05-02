/**
 * ══════════════════════════════════════════════════════════
 *  AUTO-ROUTE — Rota Automática Inteligente (Senior Edition)
 *  Foco: Processamento Silencioso, Automático e Alta Performance.
 * ══════════════════════════════════════════════════════════
 */

const RouteOptimizer = (function() {
  'use strict';

  /** Haversine (km) */
  function haversine(lat1, lng1, lat2, lng2) {
    if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return Infinity;
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** Nearest Neighbor + 2-opt Optimization */
  function optimize(origin, points) {
    if (!points.length) return [];
    
    // Nearest Neighbor (Greedy)
    const remaining = [...points];
    const sorted = [];
    let curLat = origin.lat;
    let curLng = origin.lng;

    while (remaining.length > 0) {
      let bestIdx = 0;
      let minDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = haversine(curLat, curLng, remaining[i].lat, remaining[i].lng);
        // Prioridade pesa na distância (locais prioritários parecem estar "mais perto")
        const weight = remaining[i].priority ? 0.2 : 1.0; 
        if (d * weight < minDist) {
          minDist = d * weight;
          bestIdx = i;
        }
      }
      const next = remaining.splice(bestIdx, 1)[0];
      sorted.push(next);
      curLat = next.lat;
      curLng = next.lng;
    }

    // 2-opt Heuristic (Simple local search)
    // Reduz cruzamentos em rotas pequenas/médias
    for (let i = 0; i < 50; i++) { // Max iterations
      let improved = false;
      for (let j = 1; j < sorted.length - 1; j++) {
        for (let k = j + 1; k < sorted.length; k++) {
          const d1 = haversine(sorted[j-1].lat, sorted[j-1].lng, sorted[j].lat, sorted[j].lng) +
                     (sorted[k+1] ? haversine(sorted[k].lat, sorted[k].lng, sorted[k+1].lat, sorted[k+1].lng) : 0);
          
          const d2 = haversine(sorted[j-1].lat, sorted[j-1].lng, sorted[k].lat, sorted[k].lng) +
                     (sorted[k+1] ? haversine(sorted[j].lat, sorted[j].lng, sorted[k+1].lat, sorted[k+1].lng) : 0);

          if (d2 < d1) {
            // Reverse segment
            const segment = sorted.slice(j, k + 1).reverse();
            sorted.splice(j, k - j + 1, ...segment);
            improved = true;
          }
        }
      }
      if (!improved) break;
    }

    return sorted;
  }

  return {
    calcular: async function(locations, options = {}) {
      const { usarGeolocalizacao = true } = options;
      const result = {
        rota: [],
        origem: null,
        distanciaTotalKm: 0,
        tempoEstimadoMin: 0,
        urlGoogleMaps: '',
        erros: []
      };

      try {
        // 1. Obter Origem (GPS)
        let origin = { lat: -23.5505, lng: -46.6333, nome: 'Sua Localização' }; // Fallback SP
        if (usarGeolocalizacao && navigator.geolocation) {
          try {
            const pos = await new Promise((resolve, reject) => {
              navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: false, timeout: 5000, maximumAge: 300000
              });
            });
            origin = { lat: pos.coords.latitude, lng: pos.coords.longitude, nome: 'Você' };
          } catch (e) {
            console.warn('[RouteOptimizer] Falha GPS:', e.message);
          }
        }
        result.origem = origin;

        // 2. Resolver Coordenadas em Paralelo
        const resolved = await Promise.allSettled(locations.map(async loc => {
          const addr = loc.address || loc.link || loc.input || loc.originalInput || '';
          let lat = loc.lat, lng = loc.lng;

          if (lat == null || lng == null) {
            const extractor = window.extractCoordsFromUrl || ((u) => null);
            const extracted = extractor(addr);
            if (extracted) {
              lat = extracted.lat;
              lng = extracted.lng;
            }
          }

          if (lat != null && lng != null) {
            return { ...loc, lat, lng, hasCoords: true };
          } else {
            throw new Error(`Não foi possível resolver: ${loc.name || addr}`);
          }
        }));

        const validPoints = resolved
          .filter(r => r.status === 'fulfilled')
          .map(r => r.value);
        
        result.erros = resolved
          .filter(r => r.status === 'rejected')
          .map(r => r.reason.message);

        // 3. Otimizar
        const priorityPoints = validPoints.filter(p => p.priority);
        const normalPoints   = validPoints.filter(p => !p.priority);

        // Ordena prioridades primeiro, depois normais
        const optPriority = optimize(origin, priorityPoints);
        const lastPrio = optPriority.length > 0 ? optPriority[optPriority.length-1] : origin;
        const optNormal   = optimize(lastPrio, normalPoints);

        result.rota = [...optPriority, ...optNormal];

        // 4. Métricas e URL
        let prev = origin;
        let totalKm = 0;
        result.rota.forEach((pt, i) => {
          pt.ordem = i + 1;
          const d = haversine(prev.lat, prev.lng, pt.lat, pt.lng);
          pt.distanciaAnterior = Math.round(d * 10) / 10;
          totalKm += d;
          prev = pt;
        });

        result.distanciaTotalKm = Math.round(totalKm * 10) / 10;
        result.tempoEstimadoMin = Math.round(totalKm * 1.5 + result.rota.length * 3); // Média 40km/h + 3min por parada

        // URL Google Maps (Directions)
        // Format: /dir/Origin/Pt1/Pt2/...
        const waypoints = [origin, ...result.rota].map(p => `${p.lat},${p.lng}`).join('/');
        result.urlGoogleMaps = `https://www.google.com/maps/dir/${waypoints}`;

        return result;
      } catch (err) {
        console.error('[RouteOptimizer] Erro Fatal:', err);
        throw err;
      }
    }
  };
})();

/**
 * ── UI INTEGRATION ──
 */
(function() {
  let currentResult = null;

  window.openAutoRouteModal = async function() {
    const modal = document.getElementById('autoRouteModal');
    if (!modal) return;
    
    // Fecha modal de escolha se aberto
    if (window.closeRouteChoiceModal) window.closeRouteChoiceModal();
    
    modal.classList.add('active');
    
    // Reset UI para estado "Calculando"
    document.getElementById('arLocList').innerHTML = '';
    document.getElementById('arResultSection').classList.remove('ar-visible');
    const statusText = document.getElementById('arStatusText');
    const statusBar = document.getElementById('arStatusBar');
    if (statusText) statusText.textContent = 'Calculando melhor rota para hoje...';
    if (statusBar) statusBar.classList.add('ar-visible');
    
    const calcBtn = document.getElementById('arCalcBtn');
    if (calcBtn) {
      calcBtn.style.display = 'flex';
      calcBtn.disabled = true;
      calcBtn.innerHTML = '<div class="ar-spinner"></div> Otimizando...';
    }

    try {
      // Pega locais do app.js
      const rawLocs = window.getAutoRouteLocations ? window.getAutoRouteLocations() : [];
      if (!rawLocs || rawLocs.length === 0) {
        throw new Error('Nenhum local encontrado na agenda.');
      }

      // Executa cálculo silencioso
      currentResult = await RouteOptimizer.calcular(rawLocs, { usarGeolocalizacao: true });

      // Exibe resultado
      exibirResultado(currentResult);
      
    } catch (err) {
      if (statusText) statusText.textContent = 'Erro: ' + err.message;
      if (calcBtn) {
        calcBtn.disabled = false;
        calcBtn.innerHTML = 'Tentar Novamente';
        calcBtn.onclick = window.openAutoRouteModal;
      }
    }
  };

  function exibirResultado(res) {
    const list = document.getElementById('arResultList');
    const resultSection = document.getElementById('arResultSection');
    const statusBar = document.getElementById('arStatusBar');
    const statusText = document.getElementById('arStatusText');
    const calcBtn = document.getElementById('arCalcBtn');
    const confirmBtn = document.getElementById('arConfirmBtn');

    if (statusBar) statusBar.classList.remove('ar-visible');
    if (resultSection) resultSection.classList.add('ar-visible');
    
    // Métricas
    const kmEl = document.getElementById('arStatKm');
    const stopsEl = document.getElementById('arStatStops');
    const prioEl = document.getElementById('arStatPriority');

    if (kmEl) kmEl.textContent = res.distanciaTotalKm;
    if (stopsEl) stopsEl.textContent = res.rota.length;
    if (prioEl) prioEl.textContent = res.rota.filter(p => p.priority).length;

    // Lista Ordenada no aside
    if (list) {
      list.innerHTML = res.rota.map(pt => `
        <div class="ar-result-item">
          <div class="ar-result-num">${pt.ordem}</div>
          <div class="ar-result-info">
            <div class="ar-result-name">${escapeHTML(pt.name)}</div>
            <div class="ar-result-tags">
              ${pt.priority ? '<span class="ar-result-tag ar-tag-priority">⚡ PRIORIDADE</span>' : ''}
              <span class="ar-result-dist">+${pt.distanciaAnterior} km</span>
            </div>
          </div>
        </div>
      `).join('');
    }

    // Também limpa a lista principal de seleção já que agora é automático
    const mainList = document.getElementById('arLocList');
    if (mainList) mainList.innerHTML = '<div class="ar-empty">Rota calculada com sucesso! Veja o resumo ao lado.</div>';

    // Botões
    if (calcBtn) {
      calcBtn.style.display = 'none';
    }
    if (confirmBtn) {
      confirmBtn.style.display = 'flex';
      confirmBtn.innerHTML = '🚀 Abrir no Google Maps';
      confirmBtn.onclick = () => {
        window.open(res.urlGoogleMaps, '_blank');
        // Injetar no builder do app.js para que o usuário veja os pontos no mapa principal
        if (window.setBuilderPointsAndGenerate) {
          window.setBuilderPointsAndGenerate(res.rota);
        }
        window.closeAutoRouteModal();
      };
    }
  }

  function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  window.closeAutoRouteModal = function() {
    const modal = document.getElementById('autoRouteModal');
    if (modal) modal.classList.remove('active');
  };

})();
