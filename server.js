#!/usr/bin/env node
/**
 * Minimale webserver voor de homepage.
 * Serveert statische bestanden én biedt een /api/discogs endpoint
 * dat automatisch de Discogs collectie ophaalt als de cache leeg of
 * verouderd is (ouder dan 24 uur).
 *
 * Gebruik:
 *   node server.js
 *
 * Standaard poort: 3000  (stel in via PORT omgevingsvariabele)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'discogs-data.json');
const CONFIG_FILE = path.join(__dirname, 'discogs.config.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 uur

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

// ── Config laden ──────────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`${CONFIG_FILE} niet gevonden. Maak het aan op basis van discogs.config.example.json`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

// ── Discogs ophalen ───────────────────────────────────────────────────────────
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(httpsGet(res.headers.location, headers));
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Discogs HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        } else {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Ongeldig JSON van Discogs')); }
        }
      });
    }).on('error', reject);
  });
}

async function fetchVanDiscogs(config) {
  const { consumer_key, consumer_secret, username } = config;
  const url = `https://api.discogs.com/users/${encodeURIComponent(username)}/collection/folders/0/releases?sort=added&sort_order=desc&per_page=5`;
  const headers = {
    'Authorization': `Discogs key=${consumer_key}, secret=${consumer_secret}`,
    'User-Agent': 'HomepagePlatenkast/1.0'
  };

  console.log(`[discogs] Ophalen van collectie voor: ${username}`);
  const data = await httpsGet(url, headers);

  const releases = (data.releases || []).map(r => ({
    id: r.id,
    date_added: r.date_added,
    title: r.basic_information.title,
    artist: r.basic_information.artists.map(a => a.name).join(', '),
    cover_image: r.basic_information.cover_image,
    thumb: r.basic_information.thumb,
    year: r.basic_information.year
  }));

  const output = { fetched_at: new Date().toISOString(), releases };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[discogs] ${releases.length} platen opgeslagen in cache`);
  return output;
}

// ── Cache ophalen of verversen ────────────────────────────────────────────────
let fetchInProgress = null; // voorkomt gelijktijdige fetches

async function getDiscogsData() {
  // Gebruik bestaande fetch als die al loopt
  if (fetchInProgress) return fetchInProgress;

  // Controleer cache
  if (fs.existsSync(CACHE_FILE)) {
    const stats = fs.statSync(CACHE_FILE);
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const leeftijdMs = Date.now() - stats.mtimeMs;
    const heeftData = data.releases && data.releases.length > 0;

    if (heeftData && leeftijdMs < CACHE_MAX_AGE_MS) {
      console.log(`[discogs] Cache gebruikt (${Math.round(leeftijdMs / 3600000)}u oud)`);
      return data;
    }
  }

  // Cache ontbreekt, leeg of verouderd → ophalen
  const config = loadConfig();
  fetchInProgress = fetchVanDiscogs(config).finally(() => { fetchInProgress = null; });
  return fetchInProgress;
}

// ── Statische bestanden serveren ──────────────────────────────────────────────
function serveStatic(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);

  // Beperk tot de projectmap (path traversal voorkomen)
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Verboden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Niet gevonden');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/api/discogs') {
    try {
      const data = await getDiscogsData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[discogs] Fout:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, releases: [] }));
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Homepage draait op http://localhost:${PORT}`);
});
