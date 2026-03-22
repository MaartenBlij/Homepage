#!/usr/bin/env node
/**
 * Haalt de 5 meest recente toevoegingen aan de Discogs collectie op
 * en slaat ze op in discogs-data.json. Wordt maximaal 1x per dag
 * uitgevoerd (controleert op bestandsdatum van de cache).
 *
 * Gebruik:
 *   node fetch-discogs.js
 *
 * Vereist de volgende omgevingsvariabelen:
 *   DISCOGS_CONSUMER_KEY
 *   DISCOGS_CONSUMER_SECRET
 *   DISCOGS_USERNAME
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'data', 'discogs-data.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 uur

// --- Config laden uit omgevingsvariabelen ---
const consumer_key    = process.env.DISCOGS_CONSUMER_KEY;
const consumer_secret = process.env.DISCOGS_CONSUMER_SECRET;
const username        = process.env.DISCOGS_USERNAME;

if (!consumer_key || !consumer_secret || !username) {
  console.error('Fout: omgevingsvariabelen DISCOGS_CONSUMER_KEY, DISCOGS_CONSUMER_SECRET en DISCOGS_USERNAME zijn vereist.');
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
