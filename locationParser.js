// locationParser.js
// Parser universal de localização — aceita lat/lng puro, links do WhatsApp e Google Maps.
// Retorna sempre { lat, lng, name, source, priority, originalInput }

'use strict';

const axios = require('axios');

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// ─────────────────────────────────────────────────────────────────────────────
// Padrões regex ordenados por especificidade
// ─────────────────────────────────────────────────────────────────────────────
const PATTERNS = {
  // Texto puro: "-15.7801, -47.9292" ou "-15.7801 -47.9292"
  // Exige pelo menos 4 casas decimais para evitar falso positivo com outros números
  rawCoords: /^(-?\d{1,3}\.\d{4,})[,\s]+(-?\d{1,3}\.\d{4,})$/,

  // WhatsApp envia: maps.google.com/?q=LAT,LNG ou maps.google.com/maps?q=LAT,LNG
  whatsappQ: /[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/,

  // place + @lat,lng combinados na mesma URL (mais específico — testar antes de atCoords)
  placeAt: /\/place\/[^@]+@(-?\d+\.?\d+),(-?\d+\.?\d+)/,

  // Google Maps URL longa: /maps/@lat,lng,zoom
  atCoords: /@(-?\d+\.?\d+),(-?\d+\.?\d+)/,

  // URL com ll= (formato legado do Google)
  llParam: /[?&]ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/,

  // place_id na URL (ex: ?place_id=ChIJ...)
  placeId: /place_id[=:]([A-Za-z0-9_-]+)/,

  // Nome do lugar na URL (/maps/place/Nome+do+Lugar)
  placeName: /\/maps\/place\/([^/@?&]+)/,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de detecção de tipo de URL
// ─────────────────────────────────────────────────────────────────────────────

/** Link curto que precisa de redirect: goo.gl ou maps.app.goo.gl */
function isShortLink(url) {
  return /goo\.gl\/maps|maps\.app\.goo\.gl/.test(url);
}

/** Qualquer URL do Google Maps (longa) */
function isGoogleMapsUrl(url) {
  return /google\.com\/maps|maps\.google\.com/.test(url);
}

/**
 * WhatsApp compartilha localização como:
 *   maps.google.com/?q=LAT,LNG
 *   maps.google.com/maps?q=LAT,LNG
 */
function isWhatsAppLocation(url) {
  return /maps\.google\.com/.test(url) && /[?&]q=/.test(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// Validação de coordenadas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valida e converte lat/lng strings para números.
 * Retorna { lat, lng } ou null se inválido.
 */
function validateCoords(lat, lng) {
  const la = parseFloat(lat);
  const lo = parseFloat(lng);
  if (isNaN(la) || isNaN(lo)) return null;
  if (la < -90 || la > 90) return null;
  if (lo < -180 || lo > 180) return null;
  return { lat: la, lng: lo };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chamadas à API do Google
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Segue redirects de links curtos (goo.gl / maps.app.goo.gl)
 * e retorna a URL final expandida.
 */
async function resolveShortLink(url) {
  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    // axios segue redirects automaticamente — pega a URL final
    return res.request?.res?.responseUrl || res.config?.url || url;
  } catch (err) {
    // Mesmo em erro pode ter chegado na URL final antes do timeout
    return err.request?.res?.responseUrl || url;
  }
}

/** Busca coordenadas e nome pelo place_id via Places Details API */
async function geocodeByPlaceId(placeId) {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY não definida no ambiente');
  const { data } = await axios.get(
    'https://maps.googleapis.com/maps/api/place/details/json',
    { params: { place_id: placeId, fields: 'geometry,name', key: GOOGLE_API_KEY } }
  );
  if (data.status !== 'OK') throw new Error(`Place ID inválido: ${placeId}`);
  const { lat, lng } = data.result.geometry.location;
  return { lat, lng, name: data.result.name };
}

/** Geocodifica um nome de lugar via Geocoding API */
async function geocodeByName(rawName) {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY não definida no ambiente');
  const name = decodeURIComponent(rawName.replace(/\+/g, ' '));
  const { data } = await axios.get(
    'https://maps.googleapis.com/maps/api/geocode/json',
    { params: { address: name, key: GOOGLE_API_KEY } }
  );
  if (!data.results || !data.results.length) {
    throw new Error(`Local não encontrado: ${name}`);
  }
  const { lat, lng } = data.results[0].geometry.location;
  return { lat, lng, name: data.results[0].formatted_address };
}

/**
 * Reverse geocode opcional — busca o endereço formatado a partir de coordenadas.
 * Falha silenciosamente (retorna null) para não bloquear o resultado principal.
 */
async function reverseGeocode(lat, lng) {
  if (!GOOGLE_API_KEY) return null;
  try {
    const { data } = await axios.get(
      'https://maps.googleapis.com/maps/api/geocode/json',
      { params: { latlng: `${lat},${lng}`, key: GOOGLE_API_KEY } }
    );
    return data.results?.[0]?.formatted_address || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analisa um único input de localização e retorna as coordenadas normalizadas.
 *
 * @param {string} input      - Texto: lat/lng puro, link WhatsApp ou link Google Maps
 * @param {boolean} fetchName - Se true, faz reverse geocode quando não há nome (padrão: true)
 * @returns {Promise<{ lat: number, lng: number, name: string|null, source: string }>}
 *
 * source pode ser: 'latLng' | 'whatsapp' | 'googleMaps' | 'placeId' | 'placeName'
 */
async function parseLocation(input, fetchName = true) {
  const raw = input.trim();

  // ── 1. Texto puro lat,lng ────────────────────────────────────────────────
  //    Ex: "-15.7801, -47.9292" ou "-15.7801 -47.9292"
  //    Regex exige >= 4 casas decimais para evitar falso positivo com anos, CEPs, etc.
  const rawMatch = raw.match(PATTERNS.rawCoords);
  if (rawMatch) {
    const coords = validateCoords(rawMatch[1], rawMatch[2]);
    if (coords) {
      const name = fetchName ? await reverseGeocode(coords.lat, coords.lng) : null;
      return { ...coords, name, source: 'latLng', expandedUrl: raw };
    }
  }

  // ── 2. Input deve ser URL a partir daqui ───────────────────────────────
  let url = raw;
  if (!url.startsWith('http')) {
    // Tenta encontrar um link http no meio do texto
    const urlMatch = raw.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      url = urlMatch[0];
    } else {
      throw new Error(`Formato não reconhecido: "${raw}"`);
    }
  }

  // ── 3. WhatsApp localização ──────────────────────────────────────────────
  //    Deve ser testado ANTES de resolver redirect, pois a URL já tem as coords
  if (isWhatsAppLocation(url)) {
    const m = url.match(PATTERNS.whatsappQ);
    if (m) {
      const coords = validateCoords(m[1], m[2]);
      if (coords) {
        const name = fetchName ? await reverseGeocode(coords.lat, coords.lng) : null;
        return { ...coords, name, source: 'whatsapp', expandedUrl: url };
      }
    }
  }

  // ── 4. Link curto — resolver redirect primeiro ───────────────────────────
  if (isShortLink(url)) {
    url = await resolveShortLink(url);
  }

  // ── 5. Tentar extrair coords diretamente da URL longa ───────────────────

  // (a) place + @lat,lng juntos (ex: /maps/place/Brasília/@-15.79,-47.88,12z)
  let m = url.match(PATTERNS.placeAt);
  if (m) {
    const coords = validateCoords(m[1], m[2]);
    if (coords) {
      const name = fetchName ? await reverseGeocode(coords.lat, coords.lng) : null;
      return { ...coords, name, source: 'googleMaps', expandedUrl: url };
    }
  }

  // (b) @lat,lng sozinho (ex: /maps/@-15.78,-47.92,15z)
  m = url.match(PATTERNS.atCoords);
  if (m) {
    const coords = validateCoords(m[1], m[2]);
    if (coords) {
      const name = fetchName ? await reverseGeocode(coords.lat, coords.lng) : null;
      return { ...coords, name, source: 'googleMaps', expandedUrl: url };
    }
  }

  // (c) ll= param (formato legado do Google)
  m = url.match(PATTERNS.llParam);
  if (m) {
    const coords = validateCoords(m[1], m[2]);
    if (coords) {
      const name = fetchName ? await reverseGeocode(coords.lat, coords.lng) : null;
      return { ...coords, name, source: 'googleMaps', expandedUrl: url };
    }
  }

  // (d) ?q= param em URL do Google Maps (não WhatsApp)
  m = url.match(PATTERNS.whatsappQ);
  if (m) {
    const coords = validateCoords(m[1], m[2]);
    if (coords) {
      const name = fetchName ? await reverseGeocode(coords.lat, coords.lng) : null;
      return { ...coords, name, source: 'googleMaps', expandedUrl: url };
    }
  }

  // ── 6. Fallback via API: place_id ou nome do lugar ──────────────────────

  // (e) place_id (ex: ?place_id=ChIJ...)
  m = url.match(PATTERNS.placeId);
  if (m) {
    const result = await geocodeByPlaceId(m[1]);
    return { ...result, source: 'placeId', expandedUrl: url };
  }

  // (f) Nome do lugar no path (/maps/place/Torre+de+TV/...)
  m = url.match(PATTERNS.placeName);
  if (m) {
    const result = await geocodeByName(m[1]);
    return { ...result, source: 'placeName', expandedUrl: url };
  }

  // (g) Texto no parâmetro ?q= (ex: ?q=Rua+do+Ouvidor) quando não for lat/lng
  m = url.match(/[?&]q=([^&]+)/);
  if (m) {
    const decodedName = decodeURIComponent(m[1].replace(/\+/g, ' '));
    // Se não for coordenada (que já teria sido pego lá em cima)
    if (!/^-?\d+\.?\d*,-?\d+\.?\d*$/.test(decodedName)) {
      const result = await geocodeByName(decodedName);
      return { ...result, source: 'qParam', expandedUrl: url };
    }
  }

  throw new Error(`Não foi possível extrair coordenadas de: "${raw}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Processamento em lote
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Processa N inputs de localização em paralelo.
 * Falhas individuais não quebram os demais (Promise.allSettled).
 *
 * @param {Array<{ url: string, name?: string, priority?: boolean }>} items
 * @returns {Promise<Array<PromiseSettledResult<{
 *   lat: number, lng: number, name: string, source: string,
 *   priority: boolean, originalInput: string
 * }>>>}
 */
async function parseLocations(items) {
  return Promise.allSettled(
    items.map(async (item) => {
      const result = await parseLocation(item.url);
      return {
        lat: result.lat,
        lng: result.lng,
        name: item.name || result.name || 'Local sem nome',
        source: result.source,
        priority: item.priority || false,
        originalInput: item.url,
      };
    })
  );
}

module.exports = { parseLocation, parseLocations };
