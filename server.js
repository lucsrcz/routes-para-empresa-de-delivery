const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

// ═══════════════════════════════════════════════════════════
// CONFIGURAÇÃO FIREBASE ADMIN
// ═══════════════════════════════════════════════════════════
// NOTA: Certifique-se de definir GOOGLE_APPLICATION_CREDENTIALS no ambiente
// ou inicializar com o arquivo JSON do Service Account.
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
// API DE RESOLUÇÃO DE LINKS (GOOGLE MAPS)
// ═══════════════════════════════════════════════════════════
app.post('/api/resolve', authenticate, async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL é obrigatória' });
    }

    let expandedUrl = url;
    let lat = null;
    let lng = null;
    let name = "Local Adicionado";

    // Proteção SSRF básica e resolução de links
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const allowedDomains = ['maps.app.goo.gl', 'goo.gl', 'google.com', 'maps.google.com'];
      const parsedUrl = new URL(url);
      
      if (!allowedDomains.some(domain => parsedUrl.hostname.endsWith(domain))) {
        return res.status(400).json({ error: 'Domínio não permitido para resolução.' });
      }

      try {
        const response = await axios.get(url, {
          maxRedirects: 5,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          },
          timeout: 5000 // Timeout para evitar pendências infinitas
        });
        expandedUrl = response.request.res.responseUrl || url;
      } catch (e) {
        if (e.request && e.request.res && e.request.res.responseUrl) {
          expandedUrl = e.request.res.responseUrl;
        }
      }

      // Regex para extrair coordenadas
      const atMatch = expandedUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (atMatch) {
        lat = parseFloat(atMatch[1]);
        lng = parseFloat(atMatch[2]);
      }

      // Regex para extrair nome do local
      const placeMatch = expandedUrl.match(/\/place\/([^\/]+)\//);
      if (placeMatch) {
        name = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
      } else {
        name = "Localização Resolvida";
      }
    } else {
      // Se não for link, é endereço bruto
      name = url;
    }

    res.json({ originalUrl: url, expandedUrl, lat, lng, name });

  } catch (error) {
    console.error('Erro ao resolver URL:', error.message);
    res.status(500).json({ error: 'Falha ao processar a requisição.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Smart Route Backend rodando na porta ${PORT}`);
});
