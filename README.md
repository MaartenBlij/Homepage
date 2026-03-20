# Homepage

Persoonlijke homepage van Maarten van der Blij. Gebouwd als statische HTML-pagina, geserveerd via een kleine Node.js server.

## Vereisten

- [Node.js](https://nodejs.org/) versie 18 of hoger

## Installatie

### 1. Credentials instellen

Kopieer het configuratiebestand en vul je Discogs-gegevens in:

```bash
cp discogs.config.example.json discogs.config.json
```

Open `discogs.config.json` en vul in:

```json
{
  "consumer_key": "...",
  "consumer_secret": "...",
  "username": "jouw-discogs-gebruikersnaam"
}
```

> **Let op:** `username` is je Discogs-profielnaam, niet je e-mailadres.
> Je vindt hem op [discogs.com/settings](https://www.discogs.com/settings) — linkerkolom onder je naam, of in de URL van je profiel: `discogs.com/user/jouw-gebruikersnaam`.

`discogs.config.json` staat in `.gitignore` en wordt nooit meegestuurd naar git.

### 2. Server starten

```bash
node server.js
```

De homepage is nu bereikbaar op [http://localhost:3000](http://localhost:3000).

### Optioneel: andere poort

```bash
PORT=8080 node server.js
```

## Hoe werkt de Platenkast

De pagina haalt bij het laden automatisch de 5 meest recente platen op uit je Discogs-collectie via `/api/discogs`. De server:

1. Controleert of er een recente cache beschikbaar is (`discogs-data.json`, jonger dan 24 uur)
2. Zo ja: stuurt de cache terug
3. Zo nee: haalt verse data op bij de Discogs API en slaat die op als cache

Je credentials zijn alleen zichtbaar op de server — de browser krijgt uitsluitend de albumdata te zien.

### Handmatig vernieuwen (optioneel)

Om de cache te omzeilen en direct nieuwe data te halen, verwijder je het cachebestand:

```bash
rm discogs-data.json
```

Bij de volgende paginabezoek haalt de server automatisch nieuwe data op.
