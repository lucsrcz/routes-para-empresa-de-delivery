// tests/parser.test.js
// Suite de testes para o locationParser.js
// Execute com: node tests/parser.test.js
// (sem GOOGLE_API_KEY: testes que precisam de API serão marcados como SKIP)

'use strict';

const { parseLocation } = require('../locationParser');

// ─────────────────────────────────────────────────────────────────────────────
// Casos de teste
// ─────────────────────────────────────────────────────────────────────────────
const cases = [
  // ── Lat/Lng puro ──────────────────────────────────────────────────────────
  { input: '-15.7801, -47.9292',         expectSource: 'latLng',     desc: 'lat,lng com espaço após vírgula' },
  { input: '-15.7801,-47.9292',          expectSource: 'latLng',     desc: 'lat,lng sem espaço' },
  { input: '-15.780143 -47.929241',      expectSource: 'latLng',     desc: 'lat lng separado por espaço' },

  // ── Deve FALHAR (menos de 4 casas decimais — falso positivo evitado) ─────
  { input: '-15.78 -47.92',             expectError: true,           desc: 'lat/lng com < 4 decimais (deve rejeitar)' },

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  { input: 'https://maps.google.com/?q=-15.7801,-47.9292',         expectSource: 'whatsapp', desc: 'WhatsApp ?q= formato 1' },
  { input: 'https://maps.google.com/maps?q=-15.780143,-47.929241', expectSource: 'whatsapp', desc: 'WhatsApp ?q= formato 2' },

  // ── Google Maps URL longa ─────────────────────────────────────────────────
  { input: 'https://www.google.com/maps/@-15.7801,-47.9292,15z',                              expectSource: 'googleMaps', desc: 'Maps @lat,lng simples' },
  { input: 'https://www.google.com/maps/place/Bras%C3%ADlia/@-15.7935,-47.8823,12z',          expectSource: 'googleMaps', desc: 'Maps place + @lat,lng' },
  { input: 'https://www.google.com/maps/place/Torre+de+TV/@-15.7802,-47.9288,17z',            expectSource: 'googleMaps', desc: 'Maps place nome + @lat,lng' },

  // ── Google Maps URL curta (requer rede) ───────────────────────────────────
  { input: 'https://maps.app.goo.gl/XyZ123abc',  expectSource: null, requiresNetwork: true,  desc: 'Link curto maps.app.goo.gl' },
  { input: 'https://goo.gl/maps/XyZ123abc',      expectSource: null, requiresNetwork: true,  desc: 'Link curto goo.gl/maps' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';

let passed = 0;
let failed = 0;
let skipped = 0;

(async () => {
  console.log(`\n${CYAN}══════════════════════════════════════════${RESET}`);
  console.log(`${CYAN}  locationParser — Suite de Testes${RESET}`);
  console.log(`${CYAN}══════════════════════════════════════════${RESET}\n`);

  for (const c of cases) {
    // Pula testes que precisam de rede se não há API key nem conectividade fácil
    if (c.requiresNetwork) {
      console.log(`${YELLOW}SKIP${RESET}  ${c.desc}`);
      console.log(`${DIM}       (link curto requer resolução de redirect em rede)${RESET}\n`);
      skipped++;
      continue;
    }

    try {
      const result = await parseLocation(c.input, false); // false = sem reverse geocode

      if (c.expectError) {
        // Esperávamos erro mas não veio
        console.log(`${RED}FAIL${RESET}  ${c.desc}`);
        console.log(`${DIM}       → Esperava erro, mas retornou source="${result.source}" lat=${result.lat} lng=${result.lng}${RESET}\n`);
        failed++;
      } else {
        const sourceOk = !c.expectSource || result.source === c.expectSource;
        if (sourceOk) {
          console.log(`${GREEN}OK  ${RESET}  [${result.source}] ${c.desc}`);
          console.log(`${DIM}       → lat: ${result.lat}, lng: ${result.lng}${RESET}\n`);
          passed++;
        } else {
          console.log(`${RED}FAIL${RESET}  ${c.desc}`);
          console.log(`${DIM}       → source esperado: "${c.expectSource}", recebido: "${result.source}"${RESET}\n`);
          failed++;
        }
      }
    } catch (err) {
      if (c.expectError) {
        console.log(`${GREEN}OK  ${RESET}  [error esperado] ${c.desc}`);
        console.log(`${DIM}       → ${err.message}${RESET}\n`);
        passed++;
      } else {
        console.log(`${RED}FAIL${RESET}  ${c.desc}`);
        console.log(`${DIM}       → ${err.message}${RESET}\n`);
        failed++;
      }
    }
  }

  console.log(`${CYAN}══════════════════════════════════════════${RESET}`);
  console.log(`Resultado: ${GREEN}${passed} OK${RESET}  |  ${RED}${failed} FALHOU${RESET}  |  ${YELLOW}${skipped} SKIP${RESET}`);
  console.log(`${CYAN}══════════════════════════════════════════${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
})();
