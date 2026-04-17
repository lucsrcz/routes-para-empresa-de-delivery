const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/resolve', async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Try to resolve the short link
    // Sometimes axios needs User-Agent to resolve Google Maps correctly
    const maxRedirects = 5;
    let currentUrl = url;
    let expandedUrl = url;
    let lat = null;
    let lng = null;
    let name = "Local Adicionado";

    // Verificamos se começa com http
    if (url.startsWith('http://') || url.startsWith('https://')) {
      try {
        const response = await axios.get(url, {
          maxRedirects: maxRedirects,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          }
        });
        expandedUrl = response.request.res.responseUrl || currentUrl;
      } catch (e) {
        if (e.request && e.request.res && e.request.res.responseUrl) {
          expandedUrl = e.request.res.responseUrl;
        }
      }

      // /@lat,lng,
      const atMatch = expandedUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (atMatch) {
        lat = parseFloat(atMatch[1]);
        lng = parseFloat(atMatch[2]);
      }

      // /place/Name+Here/@...
      const placeMatch = expandedUrl.match(/\/place\/([^\/]+)\//);
      if (placeMatch) {
        name = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
      } else {
        name = "Google Maps Location";
      }
    } else {
      // Se não for um link, é um endereço digitado
      expandedUrl = "";
      name = url; // O próprio campo digitado
      // Para geocodificação real precisaria da API Key do Google Geocoding
    }

    res.json({
      originalUrl: url,
      expandedUrl,
      lat,
      lng,
      name
    });

  } catch (error) {
    console.error('Error resolving URL:', error.message);
    res.status(500).json({ error: 'Failed to resolve URL' });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Smart Route Backend serving on port ${PORT}`);
});
