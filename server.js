const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const { parseLocation, parseLocations } = require('./locationParser');

// ═══════════════════════════════════════════════════════════
// CONFIGURAÇÃO FIREBASE ADMIN
// ═══════════════════════════════════════════════════════════
try {
  admin.initializeApp();
  console.log("Firebase Admin inicializado com sucesso.");
} catch (e) {
  console.warn("Firebase Admin não pôde ser inicializado (credenciais ausentes). Verifique o ambiente.");
}

const app = express();
app.use(cors());
app.use(express.json());

// Middleware de Autenticação
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autorizado. Token ausente.' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Token inválido:', error.message);
    res.status(401).json({ error: 'Token inválido.' });
  }
};

// ═══════════════════════════════════════════════════════════
// HELPERS — Algoritmo de Rota no Backend
// ═══════════════════════════════════════════════════════════

/** Haversine (km) — distância em linha reta entre dois pontos */
function haversineKm(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return Infinity;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Busca a matriz de distâncias reais de estrada via OSRM (gratuito, sem API key).
 * Retorna matriz NxN em metros, ou null se indisponível.
 */
async function fetchOSRMMatrix(coordsList) {
  if (!coordsList || coordsList.length < 2 || coordsList.length > 25) return null;
  // OSRM espera lon,lat (não lat,lon)
  const coords = coordsList.map(c => `${c.lng},${c.lat}`).join(';');
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=distance`;
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    if (data.code !== 'Ok' || !Array.isArray(data.distances)) return null;
    return data.distances; // matrix[i][j] = distância em metros de i para j
  } catch (e) {
    console.warn('[optimize-route] OSRM indisponível:', e.message);
    return null;
  }
}

/**
 * Algoritmo Nearest Neighbor usando matriz de distâncias ou fallback Haversine.
 *
 * @param {number|null} startIdx  — índice do ponto de partida na coordsList (null = sem origem conhecida)
 * @param {Array}       candidates — objetos com _mi (matrix index), lat, lng
 * @param {Array|null}  matrix    — NxN matriz OSRM em metros
 * @param {Array}       coordsList — lista de { lat, lng } indexada por matrix index
 * @returns {Array} — candidates na ordem otimizada
 */
function nearestNeighborMatrix(startIdx, candidates, matrix, coordsList) {
  const withCoords    = candidates.filter(p => p._mi != null && p.lat != null && p.lng != null);
  const withoutCoords = candidates.filter(p => p._mi == null || p.lat == null || p.lng == null);
  const remaining = [...withCoords];
  const sorted = [];
  let curIdx = startIdx;

  // Se não há ponto de partida, usa o primeiro candidato como âncora
  if (curIdx == null && remaining.length > 0) {
    const first = remaining.shift();
    sorted.push(first);
    curIdx = first._mi;
  }

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const toMI = remaining[i]._mi;
      let dist;

      if (matrix && curIdx != null && matrix[curIdx] && matrix[curIdx][toMI] != null) {
        dist = matrix[curIdx][toMI]; // metros reais de estrada
      } else {
        // Fallback Haversine (em metros para comparação consistente)
        const from = coordsList[curIdx] || coordsList[0];
        dist = haversineKm(from.lat, from.lng, remaining[i].lat, remaining[i].lng) * 1000;
      }

      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }

    const chosen = remaining.splice(bestIdx, 1)[0];
    sorted.push(chosen);
    curIdx = chosen._mi;
  }

  // Pontos sem coordenadas vão ao final
  return [...sorted, ...withoutCoords];
}

// ═══════════════════════════════════════════════════════════
// POST /api/optimize-route
// ═══════════════════════════════════════════════════════════
/**
 * Body: {
 *   userLat: number | null,
 *   userLng: number | null,
 *   locations: [{
 *     id: string,
 *     name: string,
 *     address: string,       // link ou lat,lng raw
 *     lat?: number,          // já resolvido (opcional)
 *     lng?: number,
 *     priority?: boolean
 *   }]
 * }
 *
 * Response: {
 *   sorted: [{ id, name, lat, lng, priority, distFromPrevKm, hasCoords }],
 *   totalKm: number,
 *   usedOSRM: boolean,
 *   unresolved: [{ id, name }]
 * }
 */
app.post('/api/optimize-route', authenticate, async (req, res) => {
  const { userLat, userLng, locations } = req.body;

  if (!Array.isArray(locations) || locations.length === 0) {
    return res.status(400).json({ error: 'Campo "locations" deve ser um array não vazio.' });
  }
  if (locations.length > 50) {
    return res.status(400).json({ error: 'Máximo de 50 locais por requisição.' });
  }

  // ── Passo 1: Resolver coordenadas de todos os locais em paralelo ──────────
  const resolved = await Promise.allSettled(
    locations.map(async loc => {
      // Se já tem coordenadas válidas, não precisa resolver
      if (loc.lat != null && loc.lng != null &&
          !isNaN(Number(loc.lat)) && !isNaN(Number(loc.lng))) {
        return {
          id: loc.id,
          name: loc.name || 'Local sem nome',
          lat: Number(loc.lat),
          lng: Number(loc.lng),
          priority: !!loc.priority,
          hasCoords: true,
          originalInput: loc.address || ''
        };
      }

      // Sem coordenadas — tentar resolver o endereço/link
      if (!loc.address || !loc.address.trim()) {
        return { id: loc.id, name: loc.name, hasCoords: false, priority: !!loc.priority };
      }

      const parsed = await parseLocation(loc.address.trim(), false);
      return {
        id: loc.id,
        name: loc.name || parsed.name || 'Local sem nome',
        lat: parsed.lat,
        lng: parsed.lng,
        priority: !!loc.priority,
        hasCoords: true,
        originalInput: loc.address
      };
    })
  );

  // Separar resolvidos dos que falharam
  const resolvedLocs  = [];
  const unresolvedIds = [];

  resolved.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value?.hasCoords) {
      resolvedLocs.push(result.value);
    } else {
      unresolvedIds.push({
        id: locations[i].id,
        name: locations[i].name || 'Local sem nome',
        priority: !!locations[i].priority,
        hasCoords: false
      });
    }
  });

  // ── Passo 2: Montar lista de coordenadas para a matriz OSRM ──────────────
  // Índice 0 = posição do usuário (se disponível), depois todos os locais resolvidos
  const coordsList = [];
  let userMI = null;

  const uLat = userLat != null ? Number(userLat) : null;
  const uLng = userLng != null ? Number(userLng) : null;

  if (uLat != null && uLng != null && !isNaN(uLat) && !isNaN(uLng)) {
    userMI = 0;
    coordsList.push({ lat: uLat, lng: uLng });
  }

  resolvedLocs.forEach(loc => {
    loc._mi = coordsList.length; // índice desta localização na matriz
    coordsList.push({ lat: loc.lat, lng: loc.lng });
  });

  // ── Passo 3: Buscar matriz de distâncias reais (OSRM) ────────────────────
  const matrix = await fetchOSRMMatrix(coordsList);
  const usedOSRM = matrix !== null;

  // ── Passo 4: Nearest Neighbor com prioridades na frente ──────────────────
  const priorityLocs = resolvedLocs.filter(l => l.priority);
  const normalLocs   = resolvedLocs.filter(l => !l.priority);

  // Prioridades: ordena a partir da posição do usuário
  const sortedPriority = nearestNeighborMatrix(userMI, priorityLocs, matrix, coordsList);

  // Normais: continua da última parada prioritária (ou da posição do usuário)
  let chainMI = userMI;
  if (sortedPriority.length > 0 && sortedPriority[sortedPriority.length - 1]._mi != null) {
    chainMI = sortedPriority[sortedPriority.length - 1]._mi;
  }
  const sortedNormal = nearestNeighborMatrix(chainMI, normalLocs, matrix, coordsList);

  // Sem GPS: prioritários primeiro, depois normais
  const unresolvedPriority = unresolvedIds.filter(l => l.priority);
  const unresolvedNormal   = unresolvedIds.filter(l => !l.priority);

  // Ordem final: ⚡Prioridade(GPS) → Normal(GPS) → Prioridade(sem GPS) → Normal(sem GPS)
  const allSorted = [
    ...sortedPriority,
    ...sortedNormal,
    ...unresolvedPriority,
    ...unresolvedNormal
  ];

  // ── Passo 5: Calcular distância acumulada por parada ─────────────────────
  let totalKm = 0;
  let prevLat = uLat, prevLng = uLng;

  const sortedWithDist = allSorted.map(loc => {
    let distFromPrevKm = null;

    if (loc.hasCoords !== false && loc.lat != null && prevLat != null) {
      distFromPrevKm = haversineKm(prevLat, prevLng, loc.lat, loc.lng);
      totalKm += distFromPrevKm;
      prevLat = loc.lat;
      prevLng = loc.lng;
    }

    // Limpa campo interno de controle antes de enviar
    const { _mi, ...clean } = loc;
    return { ...clean, distFromPrevKm };
  });

  return res.json({
    sorted: sortedWithDist,
    totalKm: Math.round(totalKm * 10) / 10,
    usedOSRM,
    unresolved: unresolvedIds
  });
});

// ═══════════════════════════════════════════════════════════
// API DE RESOLUÇÃO DE LOCALIZAÇÃO — parser universal
// ═══════════════════════════════════════════════════════════

app.post('/api/resolve', authenticate, async (req, res) => {
  const { url, name: customName, fetchName = true } = req.body;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'Campo "url" é obrigatório e deve ser uma string.' });
  }
  try {
    const result = await parseLocation(url.trim(), fetchName);
    return res.json({
      lat: result.lat,
      lng: result.lng,
      name: customName || result.name || 'Local sem nome',
      source: result.source,
      originalInput: url.trim(),
    });
  } catch (err) {
    console.error('[/api/resolve] Erro:', err.message);
    return res.status(422).json({ error: err.message });
  }
});

app.post('/api/resolve-batch', authenticate, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Campo "items" deve ser um array não vazio.' });
  }
  if (items.length > 50) {
    return res.status(400).json({ error: 'Máximo de 50 itens por requisição.' });
  }
  for (let i = 0; i < items.length; i++) {
    if (!items[i].url || typeof items[i].url !== 'string') {
      return res.status(400).json({ error: `Item[${i}] está faltando o campo "url".` });
    }
  }
  try {
    const results = await parseLocations(items);
    return res.json(results);
  } catch (err) {
    console.error('[/api/resolve-batch] Erro inesperado:', err.message);
    return res.status(500).json({ error: 'Falha interna ao processar o lote.' });
  }
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Smart Route Backend rodando na porta ${PORT}`);
});



