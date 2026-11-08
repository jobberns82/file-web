# Files web 1.0

Eigen bestandsbeheerder voor de ZimaOS-thuisserver, ook geschikt voor de telefoon.
Bereikbaar op `https://files.jobbes.nl` (via de Cloudflare-tunnel met Access) en thuis op poort 5580.

Versie 1.0, 5 november 2026. Het versienummer staat in zowel `server.js` als `index.html`.
Verschillen ze, dan meldt de pagina dat beide bestanden vervangen moeten worden.

## Bestanden

| Bestand | Plek op de server |
|---|---|
| `docker-compose.yml` | ZimaOS-dashboard, Custom install (app `files-web`) |
| `app/server.js` | `/DATA/AppData/files-web/app/server.js` |
| `app/public/index.html`, `icon.svg`, `apple-touch-icon.png` | `/DATA/AppData/files-web/app/public/` |
| gegevens van de app | `/DATA/AppData/files-web/data` (wordt vanzelf gemaakt) |

In `/data` staan favorieten, mapiconen, mapgroottes, miniaturen, de takenlijst en de vorige versies uit de tekstverwerker (30 dagen).

## Instellingen in de compose

- `FM_USER`, `FM_PASS`: inloggen. Zelf invullen, nooit delen.
- `FM_SYSTEEM`: naam van de systeemschijf (`ZimaOS`), daar opent de app.
- `FM_TMDB`: TMDB-token voor hernoemen. Leeg = uit.
- `FM_OS_KEY`, `FM_OS_USER`, `FM_OS_PASS`: OpenSubtitles.com. Leeg = ondertitels zoeken uit.
- Bij elke start installeert de container `vips-tools vips-heif exiftool zip ffmpeg` (miniaturen, foto-info, zip, video). Lukt dat niet, dan werkt de rest gewoon.

## Bijwerken

- Alleen `index.html` vervangen: pagina verversen is genoeg.
- `server.js` vervangen: de app `files-web` herstarten in het ZimaOS-dashboard.

## Wat hij kan

**Bladeren**
- Zijbalk met favorieten (sleepbaar) en schijven (balkje, HDD/SSD/NVMe, bolletje alleen bij bijna vol), prullenbak met vol/leeg-icoon. Zijbalk in te klappen; binnen de zijbalk scroll je nooit.
- Lijst, lijst met uitklapbare mappen en tegels (klein, midden, groot); tabbladen; terug/vooruit; kolommen naar keuze en sorteren.
- Grote mappen worden zuinig getekend (virtueel boven 300 items), miniaturen alleen wat in beeld is.
- Breedte groeit mee op grote schermen; dag/nacht/auto rechtsonder buiten het venster.

**Bewerken**
- Kopiëren, knippen, plakken, hernoemen, prullenbak, nieuwe map/bestand, uploaden (ook hele mappen), zip-download.
- Slepen naar mappen, het pad bovenin, favorieten en de prullenbak (niet naar een schijf zelf). Zelfde schijf = verplaatsen, andere schijf = kopiëren; Alt kopieert, Cmd/Shift verplaatst.
- Tekstverwerker voor json, yaml, conf, txt e.d.: controle op fouten, regelnummers, Ctrl+S; rechten, regeleinden en BOM blijven; vorige versie 30 dagen bewaard.

**Bekijken**
- Fotoviewer (ook HEIC en NEF) met foto-info.
- Videospeler met eigen bediening; venster in de verhouding van de video; video-miniaturen.

**Taken**
- Takenknop rechtsboven met voortgang; paneel met per taak het huidige bestand, tijden en resterende tijd.
- Kopiëren en verplaatsen lopen op de server door bij verversen, op een ander apparaat en na een herstart. Kopiëren schrijft echt naar de schijf ("Wegschrijven naar schijf…").

**Media**
- Hernoemen via TMDB (films en series, ook diep geneste mappen; restmappen opruimen; ongedaan maken).
- Nederlandse ondertitels via OpenSubtitles: zoeken op videohash, TMDB/IMDb-id of titel, zelf zoeken als er niets gevonden wordt; je kiest zelf wat er gedownload wordt (`naam.nl.srt`, UTF-8).

## Afspraken

- Blijf af van de Data-schijf zelf.
- Geen wachtwoorden, tokens of sleutels in documenten of chats; alleen in de compose op de server.

## Nog open

- Image: het gereedschap (vips, exiftool, zip, ffmpeg) lokaal bewaren, zodat de container zonder internet en sneller start.
