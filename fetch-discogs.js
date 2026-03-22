#!/usr/bin/env node
/**
 * Haalt de 5 meest recente toevoegingen aan de Discogs collectie op
 * en slaat ze op in discogs-data.json. Wordt maximaal 1x per dag
 * uitgevoerd (controleert op bestandsdatum van de cache).
 *
 * Gebruik:
 *   node fetch-discogs.js
 *
 * Vereist een discogs.config.json naast dit bestand:
 *   {
 *     "consumer_key": "...",
 *     "consumer_secret": "...",
 *     "username": "..."
 *   }
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'discogs.config.json');
const CACHE_FILE = path.join(__dirname, 'data', 'discogs-data.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 uur

// --- Config laden ---
if (!fs.existsSync(CONFIG_FILE)) {
  console.error(`Fout: ${CONFIG_FILE} niet gevonden.`);
  console.error('Maak een discogs.config.json aan op basis van discogs.config.example.json');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const { consumer_key, consumer_secret, username } = config;

if (!consumer_key || !consumer_secret || !username) {
  console.error('Fout: discogs.config.json moet consumer_key, consumer_secret en username bevatten.');
  process.exit(1);
}

// --- Cache check ---
if (fs.existsSync(CACHE_FILE)) {
  const stats = fs.statSync(CACHE_FILE);
  const ageMs = Date.now() - stats.mtimeMs;
  if (ageMs < CACHE_MAX_AGE_MS) {
    const uurGeleden = Math.round(ageMs / 1000 / 60 / 60);
    console.log(`Cache is ${uurGeleden} uur oud (minder dan 24 uur). Overgeslagen.`);
    process.exit(0);
  }
}

// --- Discogs API aanroepen ---
function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(httpGet(res.headers.location, headers));
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        } else {
          resolve(JSON.parse(body));
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  const url = `https://api.discogs.com/users/${encodeURIComponent(username)}/collection/folders/0/releases?sort=added&sort_order=desc&per_page=5`;
  const headers = {
    'Authorization': `Discogs key=${consumer_key}, secret=${consumer_secret}`,
    'User-Agent': 'HomepagePlatenkast/1.0 +https://github.com/maartenvdblij'
  };

  console.log(`Discogs collectie ophalen voor gebruiker: ${username}`);
  const data = await httpGet(url, headers);

  const releases = (data.releases || []).map(r => ({
    id: r.id,
    date_added: r.date_added,
    title: r.basic_information.title,
    artist: r.basic_information.artists.map(a => a.name).join(', '),
    cover_image: r.basic_information.cover_image,
    thumb: r.basic_information.thumb,
    year: r.basic_information.year
  }));

  const output = {
    fetched_at: new Date().toISOString(),
    releases
  };

  fs.writeFileSync(CACHE_FILE, JSON.stringify(output, null, 2), 'utf8');
  console.log(`${releases.length} platen opgeslagen in discogs-data.json`);
  releases.forEach(r => console.log(`  - ${r.artist} — ${r.title} (${r.year})`));
}

main().catch(err => {
  console.error('Fout bij ophalen Discogs data:', err.message);
  process.exit(1);
});
