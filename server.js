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
const matter = require('gray-matter');
const { marked } = require('marked');

const CONTENT_DIR = path.join(__dirname, 'content');

const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'data', 'discogs-data.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 uur
const LETTERBOXD_CACHE_FILE = path.join(__dirname, 'data', 'letterboxd-data.json');

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

async function fetchVanDiscogs() {
  const consumer_key    = process.env.DISCOGS_CONSUMER_KEY;
  const consumer_secret = process.env.DISCOGS_CONSUMER_SECRET;
  const username        = process.env.DISCOGS_USERNAME;

  if (!consumer_key || !consumer_secret || !username) {
    throw new Error('Omgevingsvariabelen DISCOGS_CONSUMER_KEY, DISCOGS_CONSUMER_SECRET en DISCOGS_USERNAME zijn niet ingesteld.');
  }
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
  fetchInProgress = fetchVanDiscogs().finally(() => { fetchInProgress = null; });
  return fetchInProgress;
}

// ── Letterboxd RSS ophalen ────────────────────────────────────────────────────
function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'HomepageFilms/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(httpsGetText(res.headers.location));
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Letterboxd HTTP ${res.statusCode}`));
        } else {
          resolve(body);
        }
      });
    }).on('error', reject);
  });
}

function parseLetterboxdRSS(xml) {
  const entries = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemPattern.exec(xml)) !== null) {
    const item = match[1];

    const getTag = (tag) => {
      const escaped = tag.replace(':', '\\:');
      const m = item.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`));
      if (!m) return null;
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    };

    const filmTitle = getTag('letterboxd:filmTitle');
    if (!filmTitle) continue;

    const filmYear    = getTag('letterboxd:filmYear');
    const watchedDate = getTag('letterboxd:watchedDate');
    const pubDate     = getTag('pubDate');
    const ratingStr   = getTag('letterboxd:rating');
    const description = getTag('description');

    const posterMatch = description?.match(/<img[^>]+src="([^"]+)"/);
    const posterUrl   = posterMatch ? posterMatch[1] : null;

    let reviewHtml = null;
    if (description) {
      const withoutPoster = description.replace(/<p>\s*<img[^>]+>\s*<\/p>\s*/i, '').trim();
      if (withoutPoster) reviewHtml = withoutPoster;
    }

    const linkMatch = item.match(/<link>([^<\s]+)<\/link>/);
    const guidMatch = item.match(/<guid[^>]*>([^<]+)<\/guid>/);
    const link = linkMatch?.[1]?.trim() || guidMatch?.[1]?.trim();

    const slugMatch = link?.match(/\/film\/([^/]+)\/?$/);
    const filmSlug  = slugMatch ? slugMatch[1] : filmTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const watchedDateStr = watchedDate || (pubDate ? new Date(pubDate).toISOString().split('T')[0] : null);

    let pubDateIso = null;
    try { pubDateIso = pubDate ? new Date(pubDate).toISOString() : null; } catch {}

    entries.push({
      slug: `${filmSlug}-${filmYear || '0'}-${watchedDateStr}`,
      filmTitle,
      filmYear:     filmYear ? parseInt(filmYear) : null,
      watchedDate:  watchedDateStr,
      pubDate:      pubDateIso,
      rating:       ratingStr ? parseFloat(ratingStr) : null,
      reviewHtml,
      posterUrl,
      letterboxdUrl: link?.startsWith('http') ? link : null
    });
  }

  return entries;
}

async function fetchVanLetterboxd() {
  const username = process.env.LETTERBOXD_USERNAME;
  if (!username) {
    throw new Error('Omgevingsvariabele LETTERBOXD_USERNAME is niet ingesteld.');
  }
  const url = `https://letterboxd.com/${encodeURIComponent(username)}/rss/`;

  console.log(`[letterboxd] RSS ophalen voor: ${username}`);
  const xml = await httpsGetText(url);
  const entries = parseLetterboxdRSS(xml);

  const output = { fetched_at: new Date().toISOString(), entries };
  fs.writeFileSync(LETTERBOXD_CACHE_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[letterboxd] ${entries.length} films opgeslagen in cache`);
  return output;
}

let letterboxdFetchInProgress = null;

async function getLetterboxdData() {
  if (letterboxdFetchInProgress) return letterboxdFetchInProgress;

  if (fs.existsSync(LETTERBOXD_CACHE_FILE)) {
    const stats = fs.statSync(LETTERBOXD_CACHE_FILE);
    const data  = JSON.parse(fs.readFileSync(LETTERBOXD_CACHE_FILE, 'utf8'));
    const leeftijdMs = Date.now() - stats.mtimeMs;
    const heeftData  = data.entries && data.entries.length > 0;

    if (heeftData && leeftijdMs < CACHE_MAX_AGE_MS) {
      console.log(`[letterboxd] Cache gebruikt (${Math.round(leeftijdMs / 3600000)}u oud)`);
      return data;
    }
  }

  letterboxdFetchInProgress = fetchVanLetterboxd().finally(() => { letterboxdFetchInProgress = null; });
  return letterboxdFetchInProgress;
}

// ── Content inlezen (optioneel gefilterd op tag) ───────────────────────────────
function laadContent(tagFilter) {
  if (!fs.existsSync(CONTENT_DIR)) return [];

  return fs.readdirSync(CONTENT_DIR)
    .filter(f => f.endsWith('.md'))
    .map(bestand => {
      const inhoud = fs.readFileSync(path.join(CONTENT_DIR, bestand), 'utf8');
      const { data, content } = matter(inhoud);
      const slug = bestand.replace(/\.md$/, '');
      return {
        slug,
        title:          data.title          || slug,
        date:           data.date           ? new Date(data.date).toISOString() : null,
        tags:           data.tags           || [],
        excerpt:        data.excerpt        || '',
        porties:        data.porties        || null,
        bereidingstijd: data.bereidingstijd || null,
        html:           marked(content)
      };
    })
    .filter(item => !tagFilter || item.tags.includes(tagFilter))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
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
  const [urlPath, queryString] = req.url.split('?');
  const url = urlPath;
  const params = new URLSearchParams(queryString || '');

  if (url === '/api/content') {
    try {
      const items = laadContent(params.get('tag') || null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(items));
    } catch (err) {
      console.error('[content] Fout:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  const contentMatch = url.match(/^\/api\/content\/(.+)$/);
  if (contentMatch) {
    try {
      const slug = contentMatch[1];
      const item = laadContent(null).find(p => p.slug === slug);
      if (!item) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Niet gevonden' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(item));
    } catch (err) {
      console.error('[content] Fout:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

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

  if (url === '/api/letterboxd') {
    try {
      const data = await getLetterboxdData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[letterboxd] Fout:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, entries: [] }));
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Homepage draait op http://localhost:${PORT}`);
});
