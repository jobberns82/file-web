# Files web 1.0

Eigen bestandsbeheerder voor de ZimaOS-thuisserver, ook geschikt voor de telefoon. De voorganger van File Duo.

## Installeren (eigen image)

1. Maak op de server de map `/DATA/AppData/files-web/data` (bestaat al bij een eerdere installatie; instellingen blijven dan bewaard).
2. ZimaOS › App Store › Custom install › plak `docker-compose.yml` uit deze map in de YAML-weergave.
3. Vul `FM_USER` en `FM_PASS` in (en eventueel `FM_TMDB` en de `FM_OS_*`-sleutels voor hernoemen en ondertitels).
4. Installeren. De app staat op poort 5580.

Het image `ghcr.io/jobberns82/files-web` bevat de app en alle hulpprogramma's (ffmpeg, vips, exiftool, zip). Bijwerken: Dockhand › Check for updates.

## Inhoud

| Map/bestand | Wat |
|---|---|
| `docker-compose.yml` | compose voor ZimaOS (alleen voorbeeldwaarden) |
| `Dockerfile` | bouwt het image |
| `app/server.js`, `app/public/` | de app zelf |
| `logo/` | logo als svg en png (512, 1024, 2048) |
| `README-origineel.md` | de oorspronkelijke beschrijving met alle functies (installatie met losse app-map) |
