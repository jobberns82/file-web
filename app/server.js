'use strict';
/*
 * Files web: een eenvoudige, mobielvriendelijke file manager voor ZimaOS.
 * Geen npm-pakketten nodig: alleen Node.js zelf. Voor miniaturen en foto-info
 * worden (als ze aanwezig zijn) vipsthumbnail, exiftool en zip gebruikt.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const zlib = require('zlib');

/* ---------- Instellingen ---------- */
const CFG = {
  gebruiker: process.env.FM_USER || '',
  wachtwoord: process.env.FM_PASS || '',
  poort: Number(process.env.FM_PORT) || 8080,
  schijven: process.env.FM_SCHIJVEN || '/schijven',
  data: process.env.FM_DATA || '/data',
  publiek: path.join(__dirname, 'public'),
  sessieDagen: 30,
  // schijf die op dezelfde partitie staat als /data is niet aangekoppeld (lege map op de systeemschijf)
  koppelcontrole: process.env.FM_KOPPELCONTROLE !== '0',
  // de systeemschijf (/DATA) staat bewust op dezelfde partitie als /data, die slaat de koppelcontrole over
  systeem: (process.env.FM_SYSTEEM || '').trim(),
  // TMDB (films en series hernoemen): API-sleutel of Read Access Token. Leeg = functie uit.
  tmdb: (process.env.FM_TMDB || '').trim(),
  tmdbUrl: (process.env.FM_TMDB_URL || 'https://api.themoviedb.org/3').replace(/\/$/, ''),
  tmdbBeeld: (process.env.FM_TMDB_BEELD || 'https://image.tmdb.org/t/p').replace(/\/$/, ''),
  // OpenSubtitles.com (Nederlandse ondertitels): API-sleutel, en voor 20 per dag ook gebruikersnaam en wachtwoord. Leeg = functie uit.
  osSleutel: (process.env.FM_OS_KEY || '').trim(),
  osGebruiker: (process.env.FM_OS_USER || '').trim(),
  osWachtwoord: process.env.FM_OS_PASS || '',
  osUrl: (process.env.FM_OS_URL || 'https://api.opensubtitles.com/api/v1').replace(/\/$/, ''),
};
if (!CFG.gebruiker || !CFG.wachtwoord) {
  console.error('FM_USER en FM_PASS moeten in de compose staan. Gestopt.');
  process.exit(1);
}
const VERSIE = '1.0';            // moet gelijk zijn aan VERSIE in index.html
const PRULLENBAK = '.prullenbak';          // map in de root van elke schijf
const TIJDELIJK = '.fm-deel';              // achtervoegsel voor half gekopieerde/geüploade bestanden
const GROOTTE_VERS_MS = 30 * 60 * 1000;   // mapgroottes ouder dan dit worden opnieuw berekend
const AFBEELDING = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif', 'nef', 'tif', 'tiff']);
const DIRECT_TONEN = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);  // browser kan dit zelf
const VIDEO_AFSPELEN = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus']);  // voor de speler
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', mp4: 'video/mp4', mov: 'video/quicktime',
  mkv: 'video/x-matroska', m4v: 'video/x-m4v', webm: 'video/webm', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', zip: 'application/zip', ico: 'image/x-icon',
};

fs.mkdirSync(CFG.data, { recursive: true });
fs.mkdirSync(path.join(CFG.data, 'miniaturen'), { recursive: true });

/* ---------- Hulpjes ---------- */
class Fout extends Error { constructor(code, tekst) { super(tekst); this.code = code; } }
const fout = (code, tekst) => new Fout(code, tekst);
const ext = n => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
const wacht = ms => new Promise(r => setTimeout(r, ms));

function welkGereedschap(naam) {
  return new Promise(res => execFile('sh', ['-c', `command -v ${naam}`], (e, out) => res(!e && out.trim() ? out.trim() : null)));
}
const GEREEDSCHAP = {};
(async () => {
  for (const t of ['vipsthumbnail', 'exiftool', 'zip', 'ffmpeg', 'ffprobe']) GEREEDSCHAP[t] = await welkGereedschap(t);
  log('Gereedschap:', Object.entries(GEREEDSCHAP).map(([k, v]) => `${k}=${v ? 'ja' : 'nee'}`).join(' '));
})();

function draai(cmd, args, opties = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opties });
    const uit = [], err = [];
    const klok = setTimeout(() => p.kill('SIGKILL'), opties.timeout || 60000);
    p.stdout.on('data', d => uit.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', e => { clearTimeout(klok); rej(e); });
    p.on('close', code => {
      clearTimeout(klok);
      code === 0 ? res(Buffer.concat(uit)) : rej(new Error(`${cmd} stopte met code ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`));
    });
  });
}

/* ---------- Schijven en paden ---------- */
let schijfCache = null, schijfCacheTijd = 0;
async function schijfNamen() {
  if (schijfCache && Date.now() - schijfCacheTijd < 3000) return schijfCache;
  schijfCache = await leesSchijfNamen(); schijfCacheTijd = Date.now();
  return schijfCache;
}
async function leesSchijfNamen() {
  let lijst = [];
  try { lijst = await fsp.readdir(CFG.schijven, { withFileTypes: true }); } catch { return []; }
  const namen = [];
  for (const d of lijst) {
    if (d.name.startsWith('.')) continue;
    try { if ((await fsp.stat(path.join(CFG.schijven, d.name))).isDirectory()) namen.push(d.name); } catch {}
  }
  return namen.sort((a, b) => (b === CFG.systeem) - (a === CFG.systeem) || a.localeCompare(b, 'nl', { numeric: true }));
}

function delenVan(rel) {
  if (typeof rel !== 'string' || rel.length > 4096) throw fout(400, 'Ongeldig pad');
  const delen = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  for (const d of delen) if (d === '.' || d === '..' || d.includes('\0')) throw fout(400, 'Ongeldig pad');
  return delen;
}

const rootCache = new Map();   // root -> { pad, tijd }
async function echtPadRoot(root) {
  const c = rootCache.get(root);
  if (c && Date.now() - c.tijd < 30000) return c.pad;
  const pad = await fsp.realpath(root);
  rootCache.set(root, { pad, tijd: Date.now() });
  return pad;
}
async function binnenSchijf(abs, root) {
  const echteRoot = await echtPadRoot(root);
  let p = abs;
  for (;;) {
    try {
      const r = await fsp.realpath(p);
      return r === echteRoot || r.startsWith(echteRoot + path.sep);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const op = path.dirname(p);
      if (op === p) return false;
      p = op;
    }
  }
}

let systeemDev = null;
try { systeemDev = fs.statSync(CFG.data).dev; } catch {}
async function gekoppeld(naam) {
  if (!CFG.koppelcontrole || systeemDev == null || naam === CFG.systeem) return true;
  try { return (await fsp.stat(path.join(CFG.schijven, naam))).dev !== systeemDev; } catch { return false; }
}

/** Zet een pad als "Media/Foto's/x.jpg" om naar een veilig, absoluut pad. */
async function los(rel, { prullenbakMag = false } = {}) {
  const delen = delenVan(rel);
  if (!delen.length) throw fout(400, 'Geen schijf gekozen');
  const schijf = delen[0];
  if (!(await schijfNamen()).includes(schijf)) throw fout(404, `Schijf "${schijf}" niet gevonden`);
  if (!(await gekoppeld(schijf))) throw fout(503, `Schijf "${schijf}" is niet aangekoppeld. Er wordt niets gelezen of geschreven tot hij terug is.`);
  if (delen[1] === PRULLENBAK && !prullenbakMag) throw fout(403, 'De prullenbak beheer je via Prullenbak');
  const root = path.join(CFG.schijven, schijf);
  const abs = path.join(root, ...delen.slice(1));
  if (!(await binnenSchijf(abs, root))) throw fout(403, 'Pad wijst buiten de schijf');
  return { schijf, root, abs, rel: delen.join('/'), isRoot: delen.length === 1, naam: delen[delen.length - 1] };
}

function naamFout(n) {
  if (typeof n !== 'string' || !n.trim()) return 'Naam mag niet leeg zijn';
  if (n === '.' || n === '..') return 'Ongeldige naam';
  if (/[\/\\\0]/.test(n)) return 'Een naam mag geen / of \\ bevatten';
  if (Buffer.byteLength(n) > 255) return 'Naam is te lang';
  if (n === PRULLENBAK) return 'Deze naam is gereserveerd';
  if (n.endsWith(TIJDELIJK)) return 'Deze naam is gereserveerd';
  return null;
}

async function bestaat(p) { try { await fsp.lstat(p); return true; } catch { return false; } }

async function uniekeNaam(map, naam, kopie = false) {
  const e = ext(naam);
  const basis = e && !naam.startsWith('.') ? naam.slice(0, -(e.length + 1)) : naam;
  const staart = e && !naam.startsWith('.') ? '.' + naam.slice(-(e.length)) : '';
  if (!kopie && !(await bestaat(path.join(map, naam)))) return naam;
  for (let i = kopie ? 1 : 2; i < 10000; i++) {
    const n = kopie ? `${basis} kopie${i > 1 ? ' ' + i : ''}${staart}` : `${basis} (${i})${staart}`;
    if (!(await bestaat(path.join(map, n)))) return n;
  }
  throw fout(409, 'Geen vrije naam gevonden');
}

/* ---------- Inloggen ---------- */
const geheimPad = path.join(CFG.data, 'geheim');
let GEHEIM;
try { GEHEIM = fs.readFileSync(geheimPad); } catch {
  GEHEIM = crypto.randomBytes(32);
  fs.writeFileSync(geheimPad, GEHEIM, { mode: 0o600 });
}
// sessies worden ongeldig als gebruikersnaam of wachtwoord in de compose verandert
const SLEUTEL = crypto.createHmac('sha256', GEHEIM).update(CFG.gebruiker + '\n' + CFG.wachtwoord).digest();

function maakSessie() {
  const tot = Date.now() + CFG.sessieDagen * 864e5;
  const data = `${tot}.${crypto.randomBytes(8).toString('hex')}`;
  const sig = crypto.createHmac('sha256', SLEUTEL).update(data).digest('base64url');
  return { waarde: `${data}.${sig}`, tot };
}
function geldigeSessie(waarde) {
  if (!waarde) return false;
  const i = waarde.lastIndexOf('.');
  if (i < 0) return false;
  const data = waarde.slice(0, i), sig = Buffer.from(waarde.slice(i + 1));
  const goed = Buffer.from(crypto.createHmac('sha256', SLEUTEL).update(data).digest('base64url'));
  if (sig.length !== goed.length || !crypto.timingSafeEqual(sig, goed)) return false;
  return Number(data.split('.')[0]) > Date.now();
}
function gelijk(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function koekjes(req) {
  const uit = {};
  for (const deel of (req.headers.cookie || '').split(';')) {
    const i = deel.indexOf('=');
    if (i <= 0) continue;
    const w = deel.slice(i + 1).trim();
    try { uit[deel.slice(0, i).trim()] = decodeURIComponent(w); } catch { uit[deel.slice(0, i).trim()] = w; }
  }
  return uit;
}
const pogingen = new Map(); // ip -> [tijdstippen van mislukte pogingen]
function ipVan(req) {
  return (req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '?').toString();
}
// per bezoeker max 8 fouten per 10 minuten, per verbinding (bv. via de tunnel) max 30
function sleutelsVoor(req) { return [ipVan(req), 'sock:' + (req.socket.remoteAddress || '?')]; }
function teVaak(req) {
  const nu = Date.now();
  return sleutelsVoor(req).some((k, i) => {
    const lijst = (pogingen.get(k) || []).filter(t => nu - t < 10 * 60 * 1000);
    pogingen.set(k, lijst);
    return lijst.length >= (i === 0 ? 8 : 30);
  });
}
function noteerFout(req) { for (const k of sleutelsVoor(req)) pogingen.get(k).push(Date.now()); }

/* ---------- Mapgroottes ---------- */
const grootteBestand = path.join(CFG.data, 'mapgroottes.json');
let groottes = new Map();
try { groottes = new Map(Object.entries(JSON.parse(fs.readFileSync(grootteBestand, 'utf8')))); } catch {}
let groottesVuil = false;
function bewaarGroottes() {
  if (!groottesVuil) return;
  groottesVuil = false;
  const tmp = grootteBestand + '.tmp';
  fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(groottes))).then(() => fsp.rename(tmp, grootteBestand)).catch(e => log('Kon mapgroottes niet bewaren:', e.message));
}
setInterval(bewaarGroottes, 5 * 60 * 1000).unref();   // elke 5 minuten (bij veel mappen is dit bestand groot)
function bewaarGroottesNu() {
  try { const tmp = grootteBestand + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(groottes))); fs.renameSync(tmp, grootteBestand); }
  catch (e) { log('Kon mapgroottes niet bewaren:', e.message); }
}

function zetGrootte(abs, r) { groottes.set(abs, r); groottesVuil = true; }
/** Na een wijziging: deze map en alles eronder vergeten, bovenliggende mappen als verouderd markeren. */
const teVergeten = new Set();
let vergeetKlok = null;
function vergeetGrootte(abs, isMap = true) {
  if (isMap) { teVergeten.add(abs); if (!vergeetKlok) vergeetKlok = setTimeout(vergeetNu, 400); }
  let p = path.dirname(abs);
  while (p.startsWith(CFG.schijven + '/')) {
    const r = groottes.get(p);
    if (r) r.t = 0;
    const op = path.dirname(p); if (op === p) break; p = op;
  }
  groottesVuil = true;
}

function vergeetNu() {
  vergeetKlok = null;
  if (!teVergeten.size) return;
  const weg = new Set(teVergeten); teVergeten.clear();
  // één rondgang: een map vergeten als hij zelf, of een map erboven, op de lijst staat
  for (const k of groottes.keys()) {
    for (let p = k; p.length > CFG.schijven.length;) {
      if (weg.has(p)) { groottes.delete(k); break; }
      const op = path.dirname(p); if (op === p) break; p = op;
    }
  }
  groottesVuil = true;
}

const rekenRij = [];             // absolute paden die nog berekend moeten worden
const inRekenRij = new Set();    // zelfde inhoud, om snel te kunnen opzoeken
const rekenBezig = new Set();
let rekenActief = 0;
function vraagGrootte(abs, voorrang = false) {
  if (rekenBezig.has(abs)) return;
  if (inRekenRij.has(abs)) { if (!voorrang) return; rekenRij.splice(rekenRij.indexOf(abs), 1); }
  voorrang ? rekenRij.unshift(abs) : rekenRij.push(abs);
  inRekenRij.add(abs);
  if (rekenRij.length > 5000) for (const x of rekenRij.splice(5000)) inRekenRij.delete(x);
  rekenVolgende();
}
function rekenVolgende() {
  while (rekenActief < 2 && rekenRij.length) {
    const abs = rekenRij.shift();
    inRekenRij.delete(abs);
    const r = groottes.get(abs);
    if (r && Date.now() - r.t < GROOTTE_VERS_MS) continue; // intussen al berekend (bv. via bovenliggende map)
    rekenActief++; rekenBezig.add(abs);
    meet(abs).catch(() => {}).finally(() => { rekenActief--; rekenBezig.delete(abs); rekenVolgende(); });
  }
}

async function meet(abs, dev) {
  let g = 0, b = 0, m = 0;
  let dir;
  if (dev == null) { const st = await fsp.stat(abs).catch(() => null); if (!st) return { g: 0, b: 0, m: 0 }; dev = st.dev; }
  try { dir = await fsp.opendir(abs); } catch { return { g: 0, b: 0, m: 0 }; }
  const bestanden = [];
  const isSchijfRoot = path.dirname(abs) === CFG.schijven;
  for await (const d of dir) {
    const p = path.join(abs, d.name);
    if (d.isDirectory()) {
      if (isSchijfRoot && d.name === PRULLENBAK) continue;
      const sd = await fsp.lstat(p).catch(() => null);
      if (!sd || sd.dev !== dev) continue;      // andere schijf (koppelpunt): niet meetellen
      const r = await meet(p, dev);
      g += r.g; b += r.b; m += r.m + 1;
    } else if (d.isFile()) bestanden.push(p);
  }
  for (let i = 0; i < bestanden.length; i += 64) {
    const st = await Promise.all(bestanden.slice(i, i + 64).map(p => fsp.lstat(p).catch(() => null)));
    for (const s of st) if (s) { g += s.size; b++; }
  }
  const r = { g, b, m, t: Date.now() };
  zetGrootte(abs, r);
  return r;
}

/* ---------- Nachtronde: alle mapgroottes vooraf berekenen ---------- */
let nachtBezig = false;
async function nachtronde(reden) {
  if (nachtBezig) return;
  nachtBezig = true;
  const begin = Date.now();
  try {
    for (const naam of await schijfNamen()) {
      if (!(await gekoppeld(naam))) continue;
      const root = path.join(CFG.schijven, naam);
      const t = Date.now();
      const r = await meet(root).catch(() => null);
      if (r) log(`Mapgroottes ${naam}: ${r.m} mappen, ${r.b} bestanden in ${Math.round((Date.now() - t) / 1000)} s`);
    }
    groottesVuil = true; bewaarGroottes();
  } finally { nachtBezig = false; }
  log(`Mapgroottes bijgewerkt (${reden}) in ${Math.round((Date.now() - begin) / 60000)} min`);
}
function planNachtronde() {
  const nu = new Date(), volgende = new Date(nu);
  volgende.setHours(3, 30, 0, 0);                       // elke nacht om 03:30 (tijdzone uit TZ)
  if (volgende <= nu) volgende.setDate(volgende.getDate() + 1);
  setTimeout(() => { nachtronde('nacht').finally(planNachtronde); }, volgende - nu).unref();
}
planNachtronde();
// eerste keer (nog niets bekend): na een paar minuten alvast een ronde
setTimeout(async () => {
  for (const naam of await schijfNamen()) {
    if ((await gekoppeld(naam)) && !groottes.has(path.join(CFG.schijven, naam))) return nachtronde('eerste keer');
  }
}, Number(process.env.FM_EERSTE_RONDE_MS) || 3 * 60 * 1000).unref();

// grootste mappen onder een map, uit wat al berekend is
async function grootsteMappen(rel, aantal = 25) {
  const p = await los(rel);
  const basis = p.abs;
  const lijst = [];
  for (const [k, r] of groottes) {
    if (!k.startsWith(basis + '/')) continue;
    if (k.includes('/' + PRULLENBAK + '/') || k.endsWith('/' + PRULLENBAK)) continue;
    lijst.push({ pad: path.relative(CFG.schijven, k).split(path.sep).join('/'), grootte: r.g, bestanden: r.b, diepte: path.relative(basis, k).split(path.sep).length });
  }
  lijst.sort((a, b) => b.grootte - a.grootte);
  const eigen = groottes.get(basis);
  if (!eigen) vraagGrootte(basis, true);
  return { totaal: eigen ? eigen.g : null, berekend: eigen ? eigen.t : null, mappen: lijst.slice(0, Math.min(100, aantal)), nachtBezig };
}

/* ---------- Mappen bekijken ---------- */
async function lijst(rel, verborgen) {
  const { abs, isRoot } = await los(rel);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) throw fout(404, 'Map niet gevonden');
  if (!st.isDirectory()) throw fout(400, 'Dit is geen map');
  const items = await fsp.readdir(abs, { withFileTypes: true });
  const uit = [];
  const teBerekenen = [];
  for (let i = 0; i < items.length; i += 64) {
    const groep = items.slice(i, i + 64).filter(d => {
      if (isRoot && d.name === PRULLENBAK) return false;
      if (!verborgen && (d.name.startsWith('.') || d.name.endsWith(TIJDELIJK))) return false;
      return true;
    });
    const stats = await Promise.all(groep.map(d => fsp.stat(path.join(abs, d.name)).catch(() => null)));
    groep.forEach((d, j) => {
      const s = stats[j];
      const p = path.join(abs, d.name);
      const isMap = s ? s.isDirectory() : d.isDirectory();
      const item = { naam: d.name, map: isMap, gewijzigd: s ? s.mtimeMs : null, aangemaakt: s && s.birthtimeMs ? Math.round(s.birthtimeMs) : null, link: d.isSymbolicLink() || undefined };
      if (isMap) {
        const r = groottes.get(p);
        item.grootte = r ? r.g : null;
        item.inhoud = r ? { bestanden: r.b, mappen: r.m } : null;
        if ((!r || Date.now() - r.t > GROOTTE_VERS_MS) && !d.isSymbolicLink()) teBerekenen.push(p);
      } else item.grootte = s ? s.size : null;
      if (!s) item.onleesbaar = true;
      uit.push(item);
    });
  }
  // nieuwste lijst eerst berekenen, binnen de lijst van boven naar beneden
  for (const p of teBerekenen.reverse()) vraagGrootte(p, true);
  return uit;
}

async function groottesVoor(absMap) {
  const uit = {};
  let namen = [];
  try { namen = await fsp.readdir(absMap); } catch {}
  let open = 0;
  for (const n of namen) {
    const k = path.join(absMap, n);
    const r = groottes.get(k);
    if (r) uit[n] = { grootte: r.g, bestanden: r.b, mappen: r.m };
    if (rekenBezig.has(k) || inRekenRij.has(k)) open++;
  }
  return { groottes: uit, bezig: open };
}

// soort schijf (hdd, ssd of nvme) via /sys van de host; onbekend = null
const soortCache = new Map();
function soortVanSys(sys) {
  // sys = map van het apparaat in /sys; bij een partitie staat "queue" in de map erboven
  for (const q of [sys, path.dirname(sys)]) {
    let rot;
    try { rot = fs.readFileSync(path.join(q, 'queue', 'rotational'), 'utf8').trim(); } catch { continue; }
    return rot === '1' ? 'hdd' : path.basename(q).startsWith('nvme') ? 'nvme' : 'ssd';
  }
  return null;
}
// welk apparaat (bijv. /dev/sdc) hoort bij deze map, volgens de koppelingslijst van Linux
function apparaatVan(abs, metType) {
  let beste = null;
  try {
    const ontsnap = t => t.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    for (const regel of fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
      const [links, rechts] = regel.split(' - ');
      if (!rechts) continue;
      const punt = ontsnap(links.split(' ')[4]);
      const bron = ontsnap(rechts.split(' ')[1] || '');
      if ((abs === punt || abs.startsWith(punt.endsWith('/') ? punt : punt + '/')) && (!beste || punt.length > beste.punt.length)) beste = { punt, bron, type: rechts.split(' ')[0] };
    }
  } catch {}
  if (metType) return beste ? beste.type : null;
  return beste && beste.bron.startsWith('/dev/') ? beste.bron : null;
}
function schijfSoort(abs) {
  if (soortCache.has(abs)) return soortCache.get(abs);
  let soort = null;
  // 1. via het apparaat uit de koppelingslijst (werkt ook bij btrfs en schijven zonder partitie)
  try {
    const dev = apparaatVan(abs);
    if (dev) {
      // /dev/sdc bestaat niet in de container, /sys/class/block/sdc wel
      const naam = path.basename(dev);
      soort = soortVanSys(fs.realpathSync('/sys/class/block/' + naam));
    }
  } catch {}
  // 2. via het apparaatnummer van het bestandssysteem
  if (!soort) {
    try {
      const d = fs.statSync(abs, { bigint: true }).dev;
      const maj = Number(((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn)), min = Number((d & 0xffn) | ((d >> 12n) & ~0xffn));
      soort = soortVanSys(fs.realpathSync(`/sys/dev/block/${maj}:${min}`));
    } catch {}
  }
  soortCache.set(abs, soort);
  return soort;
}

async function schijven() {
  const uit = [];
  for (const naam of await schijfNamen()) {
    const abs = path.join(CFG.schijven, naam);
    if (!(await gekoppeld(naam))) { uit.push({ naam, gekoppeld: false }); continue; }
    let totaal = null, vrij = null, gebruikt = null;
    try { const s = await fsp.statfs(abs); totaal = s.blocks * s.bsize; vrij = s.bavail * s.bsize; gebruikt = totaal - vrij; } catch {}
    uit.push({ naam, gekoppeld: true, systeem: naam === CFG.systeem, soort: schijfSoort(abs), totaal, vrij, gebruikt });
  }
  return uit;
}

/* ---------- Eigenschappen ---------- */
function cameraNaam(merk, model) {
  merk = String(merk || '').trim(); model = String(model || '').trim();
  if (!model) return merk || null;
  const eerste = merk.split(/\s+/)[0];
  if (!merk || (eerste && model.toLowerCase().startsWith(eerste.toLowerCase()))) return model;
  return `${merk.replace(/\s+(CORPORATION|Corp\.?|Co\.,? Ltd\.?|IMAGING CORP\.)$/i, '')} ${model}`;
}
const datum = s => { const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)/.exec(s || ''); return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : (s || null); };

async function fotoInfo(abs) {
  if (!GEREEDSCHAP.exiftool) return null;
  try {
    const uit = await draai('exiftool', ['-json', '-Make', '-Model', '-LensID', '-LensModel', '-ISO#', '-FNumber#', '-ExposureTime#',
      '-FocalLength#', '-DateTimeOriginal', '-ImageWidth#', '-ImageHeight#', '-Orientation#', '--', abs], { timeout: 15000 });
    const j = JSON.parse(uit.toString())[0] || {};
    const sluiter = j.ExposureTime ? (j.ExposureTime >= 1 ? `${j.ExposureTime}s` : `1/${Math.round(1 / j.ExposureTime)}s`) : null;
    const gedraaid = [5, 6, 7, 8].includes(j.Orientation);
    return {
      camera: cameraNaam(j.Make, j.Model),
      lens: (j.LensModel && /[a-z]/i.test(j.LensModel) ? j.LensModel : null) || (j.LensID && !/^Unknown/i.test(j.LensID) ? j.LensID : null) || j.LensModel || null,
      iso: j.ISO || null,
      diafragma: j.FNumber ? `f/${j.FNumber}` : null,
      sluiter,
      brandpunt: j.FocalLength ? `${Math.round(j.FocalLength)} mm` : null,
      genomen: datum(j.DateTimeOriginal),
      afmeting: j.ImageWidth && j.ImageHeight ? (gedraaid ? `${j.ImageHeight} × ${j.ImageWidth}` : `${j.ImageWidth} × ${j.ImageHeight}`) : null,
    };
  } catch { return null; }
}

async function eigenschappen(rel) {
  const p = await los(rel);
  const st = await fsp.stat(p.abs).catch(() => null);
  if (!st) throw fout(404, 'Niet gevonden');
  const uit = {
    naam: p.naam, pad: p.rel, map: st.isDirectory(), gewijzigd: st.mtimeMs, aangemaakt: st.birthtimeMs || null,
    rechten: (st.mode & 0o777).toString(8), eigenaar: `${st.uid}:${st.gid}`,
  };
  const ln = await fsp.lstat(p.abs);
  if (ln.isSymbolicLink()) uit.link = await fsp.readlink(p.abs).catch(() => '?');
  if (uit.map) {
    const r = groottes.get(p.abs);
    if (r) Object.assign(uit, { grootte: r.g, bestanden: r.b, mappen: r.m, berekend: r.t });
    if (!r || Date.now() - r.t > GROOTTE_VERS_MS) { vraagGrootte(p.abs, true); uit.bezig = true; }
  } else {
    uit.grootte = st.size;
    if (AFBEELDING.has(ext(p.naam))) uit.foto = await fotoInfo(p.abs);
  }
  return uit;
}

/* ---------- Taken: kopiëren en verplaatsen ---------- */
const taken = [];   // nieuwste achteraan
let taakTeller = Date.now();   // uniek, ook na een herstart (de browser onthoudt welke afgeronde taken je hebt weggehaald)
let taakLoopt = false;

function taakVoorClient(t) {
  const { af, ...rest } = t;
  return rest;
}

async function telBron(abs, stop, dev) {
  const st = await fsp.lstat(abs);
  if (!st.isDirectory()) return { bytes: st.isFile() ? st.size : 0, bestanden: 1 };
  if (dev == null) dev = st.dev;
  if (st.dev !== dev) return { bytes: 0, bestanden: 0 };
  let bytes = 0, bestanden = 0;
  const items = await fsp.readdir(abs, { withFileTypes: true });
  for (const d of items) {
    if (stop.af) break;
    const r = await telBron(path.join(abs, d.name), stop, dev).catch(() => ({ bytes: 0, bestanden: 0 }));
    bytes += r.bytes; bestanden += r.bestanden;
  }
  return { bytes, bestanden };
}

const geenReflink = new Set();   // schijven (dev) waar direct klonen niet kan
async function kopieerBestand(bron, doel, t) {
  const tmp = doel + '.' + crypto.randomBytes(3).toString('hex') + TIJDELIJK;
  const st = await fsp.stat(bron);
  t.huidig = path.basename(bron);
  try {
    let klaar = false;
    // 1. zelfde schijf en het bestandssysteem kan klonen (btrfs, XFS): direct, ongeacht de grootte
    const doelDev = (await fsp.stat(path.dirname(doel))).dev;
    if (st.dev === doelDev && !geenReflink.has(st.dev)) {
      try { await fsp.copyFile(bron, tmp, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE_FORCE); klaar = true; }
      catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); if (['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EINVAL', 'ENOSYS', 'ENOTTY'].includes(e.code)) geenReflink.add(st.dev); else throw e; }
    }
    // 2. kleinere bestanden: in één keer door de kernel laten kopiëren (snelst, geen tussenstappen)
    if (!klaar && st.size < 32 * 1024 * 1024) { await fsp.copyFile(bron, tmp, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE); klaar = true; }
    if (klaar) { t.gedaan += st.size; await fsp.chmod(tmp, st.mode & 0o777).catch(() => {}); }
    // 3. grote bestanden: in stukken, met voortgang en stopknop. Regelmatig echt naar de schijf schrijven (datasync),
    //    zodat de voortgang de schijf volgt en niet het werkgeheugen, en "klaar" ook echt klaar betekent.
    else {
      const lees = await fsp.open(bron, 'r');
      let schrijf = null;
      try {
        schrijf = await fsp.open(tmp, 'wx', st.mode & 0o777);
        const buf = Buffer.allocUnsafe(4 << 20);
        let pos = 0, sindsSync = 0, syncKan = true;
        const syncNu = async () => { if (!syncKan) return; try { await schrijf.datasync(); } catch (e) { if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(e.code)) syncKan = false; else throw e; } };
        for (;;) {
          if (t.af) throw new Error('gestopt');
          const { bytesRead } = await lees.read(buf, 0, buf.length, pos);
          if (!bytesRead) break;
          let off = 0;
          while (off < bytesRead) { const { bytesWritten } = await schrijf.write(buf, off, bytesRead - off, pos + off); off += bytesWritten; }
          pos += bytesRead; t.gedaan += bytesRead; sindsSync += bytesRead;
          if (sindsSync >= 64 << 20) { await syncNu(); sindsSync = 0; }
        }
        await syncNu();
      } finally {
        await lees.close().catch(() => {});
        if (schrijf) await schrijf.close().catch(() => {});
      }
    }
    await fsp.utimes(tmp, st.atime, st.mtime).catch(() => {});
    await fsp.rename(tmp, doel);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  t.bestanden++;
}

/** Kopieert bron naar doel (doel bestaat nog niet, of is een map waarin we samenvoegen). */
async function kopieer(bron, doel, t, beleid, dev) {
  if (t.af) throw new Error('gestopt');
  const st = await fsp.lstat(bron);
  if (st.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(bron), doel);
    t.bestanden++;
    return true;
  }
  if (!st.isDirectory()) {
    await kopieerBestand(bron, doel, t);
    return true;
  }
  if (dev == null) dev = st.dev;
  if (st.dev !== dev) {                      // andere schijf (koppelpunt): niet meekopiëren
    t.fouten.push(`${path.relative(CFG.schijven, bron)}: is een andere schijf, overgeslagen`);
    return false;
  }
  await fsp.mkdir(doel, { recursive: true });
  let alles = true;
  for (const d of await fsp.readdir(bron)) {
    if (t.af) throw new Error('gestopt');
    const b = path.join(bron, d), n = path.join(doel, d);
    try {
      if (await bestaat(n)) {
        const doelIsMap = (await fsp.lstat(n)).isDirectory();
        const bronIsMap = (await fsp.lstat(b)).isDirectory();
        if (beleid === 'overslaan') { const r = await telBron(b, t).catch(() => ({ bytes: 0 })); t.gedaan += r.bytes; alles = false; continue; }
        if (beleid === 'beide') { if (!(await kopieer(b, path.join(doel, await uniekeNaam(doel, d)), t, beleid, dev))) alles = false; continue; }
        // vervangen: mappen samenvoegen, anders het bestaande naar de prullenbak
        if (doelIsMap && bronIsMap) { if (!(await kopieer(b, n, t, beleid, dev))) alles = false; continue; }
        await naarPrullenbak(n, t.schijfVanAbs(n));
      }
      if (!(await kopieer(b, n, t, beleid, dev))) alles = false;
    } catch (e) {
      if (e.message === 'gestopt') throw e;
      alles = false;
      t.fouten.push(`${path.relative(CFG.schijven, b)}: ${leesbaar(e)}`);
      if (t.fouten.length > 200) t.fouten.length = 200;
    }
  }
  await fsp.utimes(doel, st.atime, st.mtime).catch(() => {});
  return alles;
}

/** Verplaatsen binnen dezelfde schijf naar een bestaande map: alles met rename (direct), niets kopiëren. */
async function verplaatsSamen(bron, doel, t) {
  for (const d of await fsp.readdir(bron)) {
    if (t.af) throw new Error('gestopt');
    const b = path.join(bron, d), n = path.join(doel, d);
    const bs = await fsp.lstat(b);
    const ns = await fsp.lstat(n).catch(() => null);
    if (ns && ns.isDirectory() && bs.isDirectory()) { await verplaatsSamen(b, n, t); continue; }
    if (ns) await naarPrullenbak(n, schijfVanAbs(n));   // vervangen: het oude naar de prullenbak
    await fsp.rename(b, n);
    t.bestanden++; if (bs.isFile()) t.gedaan += bs.size;
  }
  await fsp.rmdir(bron).catch(() => {});
}

// alles wat nog in het werkgeheugen staat echt naar deze schijf schrijven (kleine bestanden, mappen, namen)
function schijfSync(abs) {
  return new Promise(res => execFile('sync', ['-f', abs], { timeout: 30 * 60 * 1000 }, () => res()));
}
async function wegschrijven(t, abs) {
  const vorige = t.fase; t.fase = 'wegschrijven'; t.huidig = null;
  try { await schijfSync(abs); } finally { t.fase = vorige; }
}

function leesbaar(e) {
  const m = { ENOSPC: 'schijf is vol', EACCES: 'geen toegang', EPERM: 'niet toegestaan', ENOENT: 'bestaat niet (meer)',
    EEXIST: 'bestaat al', EROFS: 'schijf is alleen-lezen', EIO: 'lees/schrijffout op de schijf', ENAMETOOLONG: 'naam te lang' };
  return m[e.code] || e.message;
}

function schijfVanAbs(abs) {
  const rel = path.relative(CFG.schijven, abs).split(path.sep);
  return path.join(CFG.schijven, rel[0]);
}

async function voerTaakUit(t) {
  t.status = 'bezig';
  t.gestart = Date.now();
  t.fase = 'tellen';
  t.snelheid = 0;
  t.schijfVanAbs = schijfVanAbs;
  // snelheid meten (bytes per seconde, gemiddeld over de laatste seconden) voor de verwachte resterende tijd
  let vorige = 0;
  const meter = setInterval(() => {
    if (t.fase !== 'bezig') { vorige = t.gedaan; return; }
    const d = Math.max(0, t.gedaan - vorige); vorige = t.gedaan;
    t.snelheid = t.snelheid ? Math.round(t.snelheid * 0.75 + d * 0.25) : d;
  }, 1000);
  try {
    const doelMap = (await los(t.doel)).abs;
    const doelDev = (await fsp.stat(doelMap)).dev;
    // eerst tellen voor de voortgang; verplaatsen binnen een schijf hoeft niet geteld te worden (dat gaat direct),
    // en voor mappen gebruiken we de bekende groottes als die er zijn
    for (const b of t.bronnen) {
      const p = await los(b);
      const st = await fsp.lstat(p.abs).catch(() => null);
      if (!st) continue;
      if (!st.isDirectory()) { t.totaal += st.isFile() ? st.size : 0; t.totaalBestanden++; continue; }
      const c = groottes.get(p.abs);
      if (c && c.g != null) { t.totaal += c.g; t.totaalBestanden += c.b || 0; continue; }
      if (t.verplaatsen && st.dev === doelDev) continue;
      const r = await telBron(p.abs, t).catch(() => ({ bytes: 0, bestanden: 0 }));
      t.totaal += r.bytes; t.totaalBestanden += r.bestanden;
    }
    t.fase = 'bezig';
    t.gestartKopie = Date.now();
    for (const b of t.bronnen) {
      if (t.af) throw new Error('gestopt');
      const p = await los(b);
      const bronMap = path.dirname(p.abs);
      const zelfdeMap = bronMap === doelMap;
      let naam = p.naam;
      let doel = path.join(doelMap, naam);
      try {
        if (zelfdeMap && t.verplaatsen) { const r = await telBron(p.abs, t).catch(() => ({ bytes: 0 })); t.gedaan += r.bytes; continue; }
        let samenvoegen = false;
        t.huidig = naam;
        if (zelfdeMap) { naam = await uniekeNaam(doelMap, naam, true); doel = path.join(doelMap, naam); }
        else if (await bestaat(doel)) {
          if (t.beleid === 'overslaan') { const r = await telBron(p.abs, t).catch(() => ({ bytes: 0 })); t.gedaan += r.bytes; t.overgeslagen++; continue; }
          if (t.beleid === 'beide') { naam = await uniekeNaam(doelMap, naam); doel = path.join(doelMap, naam); }
          else {
            const doelIsMap = (await fsp.lstat(doel)).isDirectory();
            const bronIsMap = (await fsp.lstat(p.abs)).isDirectory();
            if (doelIsMap && bronIsMap) samenvoegen = true;
            else await naarPrullenbak(doel, schijfVanAbs(doel));
          }
        }
        const bronSt = await fsp.lstat(p.abs);
        let direct = false;
        if (t.verplaatsen && bronSt.dev === doelDev) {
          // zelfde schijf: direct verplaatsen (alleen de naam/plek verandert, er wordt niets gekopieerd)
          try {
            const r = groottes.get(p.abs);
            if (samenvoegen) await verplaatsSamen(p.abs, doel, t);
            else {
              await fsp.rename(p.abs, doel);
              t.gedaan += bronSt.isDirectory() ? (r ? r.g || 0 : 0) : bronSt.size;
              t.bestanden += bronSt.isDirectory() ? (r ? r.b || 0 : 0) : 1;
            }
            direct = true;
          } catch (e) { if (e.code !== 'EXDEV') throw e; }   // toch een andere koppeling: gewoon kopiëren
        }
        if (!direct) {
          const gelukt = await kopieer(p.abs, doel, t, t.beleid);
          if (t.verplaatsen) {
            // het origineel pas weghalen als de kopie echt op de andere schijf staat
            if (gelukt) { await wegschrijven(t, doelMap); await fsp.rm(p.abs, { recursive: true, force: true }); }
            else t.fouten.push(`${p.rel}: niet alles kon worden gekopieerd, het origineel is blijven staan`);
          }
        }
        vergeetGrootte(doel, bronSt.isDirectory());
        if (t.verplaatsen) vergeetGrootte(p.abs, bronSt.isDirectory());
      } catch (e) {
        if (e.message === 'gestopt') throw e;
        t.fouten.push(`${p.rel}: ${leesbaar(e)}`);
      }
    }
    // pas klaar als alles echt op de schijf staat
    if (t.bestanden) await wegschrijven(t, doelMap);
    t.status = t.fouten.length ? 'fouten' : 'klaar';
  } catch (e) {
    t.status = e.message === 'gestopt' ? 'gestopt' : 'fout';
    if (e.message !== 'gestopt') t.fouten.push(leesbaar(e));
  }
  clearInterval(meter);
  t.klaar = Date.now();
  t.huidig = null;
  t.fase = null;
  if (t.gedaan > t.totaal) t.totaal = t.gedaan;
  if (t.klaarSein) t.klaarSein();
  delete t.schijfVanAbs;
  log(`Taak ${t.id} (${t.verplaatsen ? 'verplaatsen' : 'kopiëren'}) → ${t.doel}: ${t.status}${t.fouten.length ? `, ${t.fouten.length} fout(en)` : ''}`);
}

async function draaiTaken() {
  if (taakLoopt) return;
  taakLoopt = true;
  try {
    for (;;) {
      const t = taken.find(x => x.status === 'wacht');
      if (!t) break;
      await voerTaakUit(t);
    }
  } finally { taakLoopt = false; }
  while (taken.length > 30) {
    const i = taken.findIndex(x => !['wacht', 'bezig'].includes(x.status));
    if (i < 0) break;
    taken.splice(i, 1);
  }
}

async function nieuweTaak({ bronnen, doel, verplaatsen, beleid }) {
  if (!Array.isArray(bronnen) || !bronnen.length || bronnen.length > 10000) throw fout(400, 'Niets geselecteerd');
  if (!['vervang', 'beide', 'overslaan'].includes(beleid)) beleid = 'beide';
  const d = await los(doel);
  const dst = await fsp.stat(d.abs).catch(() => null);
  if (!dst || !dst.isDirectory()) throw fout(400, 'Doelmap bestaat niet');
  for (const b of bronnen) {
    const p = await los(b);
    if (p.isRoot) throw fout(400, 'Een hele schijf kan niet gekopieerd worden');
    if (!(await bestaat(p.abs))) throw fout(404, `"${p.naam}" bestaat niet meer`);
    if (d.abs === p.abs || d.abs.startsWith(p.abs + '/')) throw fout(400, `"${p.naam}" kan niet in zichzelf geplakt worden`);
  }
  const t = { id: ++taakTeller, verplaatsen: !!verplaatsen, bronnen, doel: d.rel, beleid, status: 'wacht', totaal: 0, totaalBestanden: 0,
    gedaan: 0, bestanden: 0, overgeslagen: 0, fouten: [], huidig: null, gemaakt: Date.now(), af: false };
  const klaar = new Promise(r => Object.defineProperty(t, 'klaarSein', { value: r, enumerable: false }));
  taken.push(t);
  draaiTaken();
  await Promise.race([klaar, new Promise(r => setTimeout(r, 1500))]);
  return taakVoorClient(t);
}

async function conflicten(namen, doel) {
  const d = await los(doel);
  const uit = [];
  for (const n of namen.slice(0, 10000)) {
    if (typeof n !== 'string') continue;
    const delen = delenVan(n);
    if (!delen.length) continue;
    if (await bestaat(path.join(d.abs, delen[0]))) uit.push(n);
  }
  return [...new Set(uit)];
}

/* ---------- Prullenbak ---------- */
async function naarPrullenbak(abs, root) {
  const bak = path.join(root, PRULLENBAK);
  await fsp.mkdir(bak, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const st = await fsp.lstat(abs);
  const r = st.isDirectory() ? groottes.get(abs) : null;
  const info = {
    pad: path.relative(CFG.schijven, abs).split(path.sep).join('/'), naam: path.basename(abs),
    map: st.isDirectory(), grootte: st.isDirectory() ? (r ? r.g : null) : st.size, verwijderd: Date.now(),
  };
  await fsp.mkdir(path.join(bak, id));
  try {
    await fsp.rename(abs, path.join(bak, id, info.naam));
  } catch (e) {
    await fsp.rmdir(path.join(bak, id)).catch(() => {});
    if (e.code === 'EXDEV') throw fout(400, `"${info.naam}" staat op een andere koppeling en kan niet naar de prullenbak`);
    throw e;
  }
  await fsp.writeFile(path.join(bak, id + '.json'), JSON.stringify(info));
  vergeetGrootte(abs, st.isDirectory());
  return id;
}

async function prullenbakLijst() {
  const uit = [];
  for (const schijf of await schijfNamen()) {
    if (!(await gekoppeld(schijf))) continue;
    const bak = path.join(CFG.schijven, schijf, PRULLENBAK);
    let items = [];
    try { items = await fsp.readdir(bak); } catch { continue; }
    for (const f of items) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5);
      try {
        const info = JSON.parse(await fsp.readFile(path.join(bak, f), 'utf8'));
        if (info.map && info.grootte == null) {
          const abs = path.join(bak, id, info.naam);
          const r = groottes.get(abs);
          if (r) info.grootte = r.g; else vraagGrootte(abs);
        }
        uit.push({ id: `${schijf}/${id}`, schijf, ...info });
      } catch {}
    }
  }
  return uit.sort((a, b) => b.verwijderd - a.verwijderd);
}

async function prullenbakItem(sid) {
  const [schijf, id, ...rest] = String(sid).split('/');
  if (rest.length || !/^\d+-[0-9a-f]{6}$/.test(id || '')) throw fout(400, 'Ongeldig item');
  if (!(await schijfNamen()).includes(schijf)) throw fout(404, 'Schijf niet gevonden');
  if (!(await gekoppeld(schijf))) throw fout(503, `Schijf "${schijf}" is niet aangekoppeld`);
  const bak = path.join(CFG.schijven, schijf, PRULLENBAK);
  const info = JSON.parse(await fsp.readFile(path.join(bak, id + '.json'), 'utf8').catch(() => { throw fout(404, 'Item niet meer in de prullenbak'); }));
  return { schijf, id, bak, info, abs: path.join(bak, id, info.naam) };
}

async function terugzetten(sid) {
  const it = await prullenbakItem(sid);
  const doelRel = it.info.pad;
  const delen = delenVan(doelRel);
  if (delen[0] !== it.schijf) throw fout(400, 'Ongeldig origineel pad');
  const p = await los(doelRel);
  const map = path.dirname(p.abs);
  await fsp.mkdir(map, { recursive: true });
  const naam = await uniekeNaam(map, path.basename(p.abs));
  await fsp.rename(it.abs, path.join(map, naam));
  await fsp.rm(path.join(it.bak, it.id), { recursive: true, force: true });
  await fsp.rm(path.join(it.bak, it.id + '.json'), { force: true });
  vergeetGrootte(path.join(map, naam));
  return path.relative(CFG.schijven, path.join(map, naam)).split(path.sep).join('/');
}

async function definitiefWeg(sid) {
  const it = await prullenbakItem(sid);
  await fsp.rm(path.join(it.bak, it.id), { recursive: true, force: true });
  await fsp.rm(path.join(it.bak, it.id + '.json'), { force: true });
  vergeetGrootte(path.join(it.bak, it.id));
}

/* ---------- Miniaturen ---------- */
const miniBezig = new Map();
const miniMislukt = new Map();   // sleutel -> tijdstip, zodat we niet steeds opnieuw proberen
let miniActief = 0;
const miniRij = [];
// voorrang: de grote weergave in de fotoviewer gaat voor de miniaturen in de lijst
function miniSlot(voorrang) {
  return new Promise(res => { if (miniActief < 3) { miniActief++; res(); } else if (voorrang) miniRij.unshift(res); else miniRij.push(res); });
}
function miniVrij() { const v = miniRij.shift(); if (v) v(); else miniActief--; }

class Afgebroken extends Error {}
async function maakMiniatuur(abs, st, maat, weg) {
  const px = maat === 'groot' ? 2048 : 400;
  const sleutel = crypto.createHash('sha1').update(`${abs}\n${st.size}\n${st.mtimeMs}\n${px}`).digest('hex');
  const map = path.join(CFG.data, 'miniaturen', sleutel.slice(0, 2));
  const uit = path.join(map, sleutel + '.jpg');
  if (await bestaat(uit)) return uit;
  if (miniBezig.has(uit)) return miniBezig.get(uit);
  if (Date.now() - (miniMislukt.get(uit) || 0) < 3600e3) throw fout(415, 'Geen voorbeeld beschikbaar');
  const klus = (async () => {
    if (!GEREEDSCHAP.vipsthumbnail) throw fout(501, 'Miniaturen niet beschikbaar');
    await fsp.mkdir(map, { recursive: true });
    await miniSlot(maat === 'groot');
    // de browser vraagt er niet meer om (weggescrold of andere map): niet voor niets rekenen
    if (weg && weg()) { miniVrij(); throw new Afgebroken('afgebroken'); }
    const werk = path.join(CFG.data, 'miniaturen', 'werk-' + crypto.randomBytes(4).toString('hex'));
    try {
      let bron = abs;
      if (VIDEO_EXT.has(ext(abs))) {
        // video: één beeld van ongeveer 10% van de film (voorbij zwarte begintitels), maximaal 5 minuten erin
        if (!GEREEDSCHAP.ffmpeg) throw fout(501, 'ffmpeg ontbreekt voor videominiaturen');
        let duur = 0;
        if (GEREEDSCHAP.ffprobe) {
          const d = await draai('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '--', abs], { timeout: 20000 }).catch(() => null);
          duur = d ? parseFloat(String(d)) || 0 : 0;
        }
        const t = duur > 2 ? Math.min(300, Math.max(1, duur * 0.1)) : 0;
        bron = werk + '.jpg';
        const beeld = async sec => {
          await draai('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '2', '-ss', String(sec), '-i', abs, '-frames:v', '1', '-an', '-sn', '-vf', "scale='min(1600,iw)':-2", '-q:v', '3', '-y', bron], { timeout: 60000 }).catch(() => {});
          const st2 = await fsp.stat(bron).catch(() => null);
          return !!(st2 && st2.size > 500);
        };
        if (!(await beeld(t)) && !(t && await beeld(0))) throw fout(415, 'Geen beeld uit deze video');
      } else if (ext(abs) === 'nef') {
        if (!GEREEDSCHAP.exiftool) throw fout(501, 'exiftool ontbreekt voor NEF');
        let jpg = null;
        for (const tag of ['-JpgFromRaw', '-PreviewImage', '-OtherImage']) {
          const b = await draai('exiftool', ['-b', tag, '--', abs], { timeout: 30000 }).catch(() => null);
          if (b && b.length > 1000) { jpg = b; break; }
        }
        if (!jpg) throw fout(415, 'Geen voorbeeld in dit RAW-bestand');
        bron = werk + '.jpg';
        await fsp.writeFile(bron, jpg);
        // stand (portret/landschap) overnemen uit het RAW-bestand
        await draai('exiftool', ['-overwrite_original', '-q', '-TagsFromFile', abs, '-Orientation', bron], { timeout: 15000 }).catch(() => {});
      }
      const tmp = werk + '-uit.jpg';
      let gelukt = false, laatste;
      for (const opt of ['[Q=82,keep=none]', '[Q=82,strip]', '[Q=82]']) {
        try {
          await draai('vipsthumbnail', [bron, '--size', `${px}x${px}`, '-o', tmp + opt], { timeout: 60000 });
          gelukt = true; break;
        } catch (e) { laatste = e; }
      }
      if (!gelukt) throw laatste;
      await fsp.rename(tmp, uit);
      return uit;
    } finally {
      miniVrij();
      await fsp.rm(werk + '.jpg', { force: true }).catch(() => {});
      await fsp.rm(werk + '-uit.jpg', { force: true }).catch(() => {});
    }
  })();
  miniBezig.set(uit, klus);
  try { return await klus; }
  catch (e) {
    if (e instanceof Fout && e.code === 501) throw e;
    if (e instanceof Afgebroken) throw fout(499, 'Afgebroken');
    miniMislukt.set(uit, Date.now());
    if (miniMislukt.size > 5000) miniMislukt.clear();
    log('Geen miniatuur voor', path.relative(CFG.schijven, abs), '-', String(e.message).split('\n')[0].slice(0, 160));
    throw fout(415, 'Geen voorbeeld beschikbaar');
  }
  finally { miniBezig.delete(uit); }
}

// miniaturen die 60 dagen niet zijn aangemaakt of vernieuwd worden opgeruimd (ze worden zo nodig opnieuw gemaakt)
async function ruimMiniaturenOp() {
  const basis = path.join(CFG.data, 'miniaturen');
  let weg = 0;
  for (const sub of await fsp.readdir(basis).catch(() => [])) {
    const map = path.join(basis, sub);
    if (sub.startsWith('werk-')) { await fsp.rm(map, { force: true }).catch(() => {}); continue; }
    for (const f of await fsp.readdir(map).catch(() => [])) {
      const st = await fsp.stat(path.join(map, f)).catch(() => null);
      if (st && Date.now() - st.atimeMs > 60 * 864e5 && Date.now() - st.mtimeMs > 60 * 864e5) { await fsp.rm(path.join(map, f), { force: true }).catch(() => {}); weg++; }
    }
  }
  if (weg) log(`${weg} oude miniaturen opgeruimd`);
}
setTimeout(ruimMiniaturenOp, 60000).unref();
setInterval(ruimMiniaturenOp, 864e5).unref();

/* ---------- Favorieten (gedeeld tussen al je apparaten) ---------- */
const favBestand = path.join(CFG.data, 'favorieten.json');
function leesFavorieten() {
  try { const j = JSON.parse(fs.readFileSync(favBestand, 'utf8')); return Array.isArray(j) ? j.filter(x => typeof x === 'string') : []; }
  catch { return []; }
}
async function bewaarFavorieten(lijst) {
  const tmp = favBestand + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(lijst));
  await fsp.rename(tmp, favBestand);
}
async function favorietenMetStatus() {
  const uit = [];
  for (const pad of leesFavorieten()) {
    let bestaat = false;
    try { const p = await los(pad); const st = await fsp.stat(p.abs); bestaat = st.isDirectory(); } catch {}
    uit.push({ pad, bestaat });
  }
  return uit;
}
async function wijzigFavorieten(b) {
  let lijst = leesFavorieten();
  if (Array.isArray(b.lijst)) {                       // volledige lijst (bijv. ongedaan maken)
    lijst = [];
    for (const x of b.lijst.slice(0, 50)) if (typeof x === 'string') { const r = delenVan(x).join('/'); if (r && !lijst.includes(r)) lijst.push(r); }
  } else {
    const rel = delenVan(b.pad || '').join('/');
    if (!rel) throw fout(400, 'Geen map gekozen');
    if (b.actie === 'toevoegen') {
      const p = await los(rel);
      const st = await fsp.stat(p.abs).catch(() => null);
      if (!st || !st.isDirectory()) throw fout(400, 'Alleen mappen kunnen favoriet worden');
      if (!lijst.includes(rel)) { if (lijst.length >= 50) throw fout(400, 'Maximaal 50 favorieten'); lijst.push(rel); }
    } else if (b.actie === 'verwijderen') lijst = lijst.filter(x => x !== rel);
    else throw fout(400, 'Onbekende actie');
  }
  await bewaarFavorieten(lijst);
  return { favorieten: await favorietenMetStatus() };
}
// na hernoemen: favorieten in (of onder) de oude map meeverhuizen
async function favorietenHernoemd(oud, nieuw) {
  const lijst = leesFavorieten();
  let veranderd = false;
  const nieuweLijst = lijst.map(f => {
    if (f === oud || f.startsWith(oud + '/')) { veranderd = true; return nieuw + f.slice(oud.length); }
    return f;
  });
  if (veranderd) await bewaarFavorieten(nieuweLijst).catch(() => {});
}

/* ---------- Mapiconen (per map een categorie, gedeeld tussen al je apparaten) ---------- */
const MAPSOORTEN = new Set(['data', 'fotos', 'films', 'series', 'documenten', 'downloads', 'muziek', 'backup', 'werk', 'klanten', 'familie', 'archief', 'prive', 'apps']);
const iconenBestand = path.join(CFG.data, 'mapiconen.json');
function leesMapIconen() {
  try { const j = JSON.parse(fs.readFileSync(iconenBestand, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}
async function bewaarMapIconen(m) {
  const tmp = iconenBestand + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(m));
  await fsp.rename(tmp, iconenBestand);
}
async function zetMapIcoon(b) {
  const rel = delenVan(b.pad || '').join('/');
  if (!rel) throw fout(400, 'Geen map gekozen');
  const p = await los(rel);
  const st = await fsp.stat(p.abs).catch(() => null);
  if (!st || !st.isDirectory()) throw fout(400, 'Alleen mappen kunnen een icoon krijgen');
  const m = leesMapIconen();
  if (!b.soort) delete m[rel];
  else if (MAPSOORTEN.has(b.soort)) m[rel] = b.soort;
  else throw fout(400, 'Onbekend icoon');
  await bewaarMapIconen(m);
  return { iconen: m };
}
async function mapIconenHernoemd(oud, nieuw) {
  const m = leesMapIconen();
  let veranderd = false;
  for (const k of Object.keys(m)) {
    if (k === oud || k.startsWith(oud + '/')) { m[nieuw + k.slice(oud.length)] = m[k]; delete m[k]; veranderd = true; }
  }
  if (veranderd) await bewaarMapIconen(m).catch(() => {});
}

/* ---------- HTTP ---------- */
function wilGzip(req) { return /\bgzip\b/.test(req.headers['accept-encoding'] || ''); }
function stuurJson(res, code, data) {
  let b = Buffer.from(JSON.stringify(data));
  const kop = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (b.length > 8192 && res.req && wilGzip(res.req)) { b = zlib.gzipSync(b, { level: 4 }); kop['Content-Encoding'] = 'gzip'; kop.Vary = 'Accept-Encoding'; }
  kop['Content-Length'] = b.length;
  res.writeHead(code, kop);
  res.end(b);
}
// de pagina zelf (index.html, icoontjes): in het geheugen, gecomprimeerd, en niet opnieuw sturen als hij niet veranderd is
const statischCache = new Map();
async function stuurStatisch(req, res, abs, st, naam) {
  let c = statischCache.get(abs);
  if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
    const data = await fsp.readFile(abs);
    const comprimeer = /\.(html|js|css|svg|json)$/.test(naam);
    c = { mtime: st.mtimeMs, size: st.size, data, gz: comprimeer ? zlib.gzipSync(data, { level: 9 }) : null,
      etag: `"${crypto.createHash('sha1').update(data).digest('hex').slice(0, 16)}"` };
    statischCache.set(abs, c);
  }
  const kop = {
    'Content-Type': MIME[ext(naam)] || 'application/octet-stream',
    'Cache-Control': naam.endsWith('.html') ? 'no-cache' : 'public, max-age=86400',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    ETag: c.etag, Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, kop); return res.end(); }
  const gz = c.gz && wilGzip(req);
  const body = gz ? c.gz : c.data;
  if (gz) kop['Content-Encoding'] = 'gzip';
  kop['Content-Length'] = body.length;
  res.writeHead(200, kop);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function leesJson(req, max = 2e6) {
  return new Promise((res, rej) => {
    const delen = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > max) { rej(fout(413, 'Te groot')); req.destroy(); } else delen.push(d); });
    req.on('end', () => { try { res(n ? JSON.parse(Buffer.concat(delen).toString()) : {}); } catch { rej(fout(400, 'Ongeldige JSON')); } });
    req.on('error', rej);
  });
}

function veiligeBestandsnaam(n) {
  return encodeURIComponent(n).replace(/['()]/g, escape);
}

async function stuurBestand(req, res, abs, { download = false, naam, cache = false } = {}) {
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw fout(404, 'Bestand niet gevonden');
  const e = ext(abs);
  const veiligInline = DIRECT_TONEN.has(e) || VIDEO_AFSPELEN.has(e);
  const kop = {
    'Content-Type': MIME[e] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    'Cache-Control': cache ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    // bestanden van schijf mogen nooit scripts uitvoeren in deze site
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
  const n = naam || path.basename(abs);
  kop['Content-Disposition'] = `${download || !veiligInline ? 'attachment' : 'inline'}; filename*=UTF-8''${veiligeBestandsnaam(n)}`;
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  kop.ETag = etag;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, kop); return res.end(); }
  let start = 0, eind = st.size - 1, code = 200;
  const bereik = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (bereik && st.size > 0) {
    if (bereik[1] === '' && bereik[2] !== '') { start = Math.max(0, st.size - Number(bereik[2])); }
    else { start = Number(bereik[1]); if (bereik[2] !== '') eind = Math.min(eind, Number(bereik[2])); }
    if (start > eind || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    code = 206; kop['Content-Range'] = `bytes ${start}-${eind}/${st.size}`;
  }
  kop['Content-Length'] = st.size ? eind - start + 1 : 0;
  res.writeHead(code, kop);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  const s = fs.createReadStream(abs, { start, end: eind });
  s.on('error', () => res.destroy());
  res.on('close', () => s.destroy());
  s.pipe(res);
}

async function stuurZip(req, res, paden) {
  if (!GEREEDSCHAP.zip) throw fout(501, 'Downloaden als zip is niet beschikbaar');
  if (!Array.isArray(paden) || !paden.length) throw fout(400, 'Niets gekozen');
  const los_ = [];
  for (const p of paden) los_.push(await los(p));
  const map = path.dirname(los_[0].abs);
  if (los_.some(p => path.dirname(p.abs) !== map || p.isRoot)) throw fout(400, 'Alles moet in dezelfde map staan');
  const naam = los_.length === 1 ? los_[0].naam + '.zip' : (path.basename(map) || 'download') + '.zip';
  res.writeHead(200, {
    'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${veiligeBestandsnaam(naam)}`,
  });
  // -0: niet comprimeren (foto's en video's zijn al gecomprimeerd), dat is veel sneller
  const z = spawn('zip', ['-r', '-q', '-0', '-', '--', ...los_.map(p => p.naam)], { cwd: map, stdio: ['ignore', 'pipe', 'ignore'] });
  z.stdout.pipe(res);
  res.on('close', () => { if (z.exitCode === null) z.kill('SIGKILL'); });
  z.on('error', () => res.destroy());
}

/* ---------- Zoeken in submappen ---------- */
const normaal = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
async function zoek(req, res, q) {
  const woorden = normaal(q.get('q') || '').split(/\s+/).filter(Boolean);
  if (!woorden.length || woorden.join('').length < 2) throw fout(400, 'Typ minstens 2 tekens');
  const verborgen = q.get('verborgen') === '1';
  const starts = [];
  if (q.get('overal') === '1') { for (const n of await schijfNamen()) if (await gekoppeld(n)) starts.push(await los(n)); }
  else starts.push(await los(q.get('pad') || ''));
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  let af = false;
  res.on('close', () => { af = true; });
  const MAX = 500, eind = Date.now() + 120000;
  let gevonden = 0, doorzocht = 0, laatsteMelding = Date.now();
  const schrijf = o => { if (!af) res.write(JSON.stringify(o) + '\n'); };
  // breedte eerst: ondiepe resultaten komen het eerst
  const rij = starts.map(p => ({ abs: p.abs, rel: p.rel, root: true }));
  let devs = new Map();
  for (const p of starts) { const st = await fsp.stat(p.abs).catch(() => null); if (st) devs.set(p.schijf, st.dev); }
  while (rij.length && !af && gevonden < MAX && Date.now() < eind) {
    const { abs, rel, root } = rij.shift();
    const dev = devs.get(rel.split('/')[0]);
    let dir;
    try { dir = await fsp.opendir(abs); } catch { continue; }
    try {
      for await (const d of dir) {
        if (af || gevonden >= MAX) break;
        const n = d.name;
        if (root && rel.indexOf('/') < 0 && n === PRULLENBAK) continue;
        if (n.endsWith(TIJDELIJK)) continue;
        if (!verborgen && n.startsWith('.')) continue;
        doorzocht++;
        const p = path.join(abs, n), r = rel + '/' + n;
        const isMap = d.isDirectory();
        if (isMap) {
          const st = await fsp.lstat(p).catch(() => null);
          if (st && st.dev === dev) rij.push({ abs: p, rel: r, root: false });
        }
        const nn = normaal(n);
        if (woorden.every(w => nn.includes(w))) {
          const st = await fsp.stat(p).catch(() => null);
          const g = isMap ? groottes.get(p) : null;
          gevonden++;
          schrijf({ item: { pad: r, naam: n, map: st ? st.isDirectory() : isMap, grootte: isMap ? (g ? g.g : null) : (st ? st.size : null), gewijzigd: st ? st.mtimeMs : null, aangemaakt: st && st.birthtimeMs ? Math.round(st.birthtimeMs) : null } });
        }
        if (doorzocht % 400 === 0) {
          await new Promise(r => setImmediate(r));
          if (Date.now() - laatsteMelding > 800) { laatsteMelding = Date.now(); schrijf({ voortgang: doorzocht }); }
        }
      }
    } catch {}
  }
  schrijf({ klaar: true, doorzocht, gevonden, afgekapt: gevonden >= MAX, tijdOp: Date.now() >= eind });
  if (!af) res.end();
}

async function upload(req, res, q) {
  const d = await los(q.get('map') || '');
  const delen = delenVan(q.get('naam') || '');
  if (!delen.length) throw fout(400, 'Geen naam');
  for (const n of delen) { const f = naamFout(n); if (f) throw fout(400, f); }
  const dst = await fsp.stat(d.abs).catch(() => null);
  if (!dst || !dst.isDirectory()) throw fout(404, 'Doelmap bestaat niet');
  const map = path.join(d.abs, ...delen.slice(0, -1));
  if (!(await binnenSchijf(map, d.root))) throw fout(403, 'Pad wijst buiten de schijf');
  await fsp.mkdir(map, { recursive: true });
  let naam = delen[delen.length - 1];
  const beleid = q.get('beleid') || 'beide';
  let doel = path.join(map, naam);
  if (await bestaat(doel)) {
    if (beleid === 'overslaan') { req.resume(); return { overgeslagen: true }; }
    if (beleid === 'vervang' && !(await fsp.lstat(doel)).isDirectory()) await naarPrullenbak(doel, d.root);
    else { naam = await uniekeNaam(map, naam); doel = path.join(map, naam); }
  }
  const tmp = doel + '.' + crypto.randomBytes(3).toString('hex') + TIJDELIJK;
  await new Promise((ok, mis) => {
    const s = fs.createWriteStream(tmp, { flags: 'wx' });
    let klaar = false;
    req.on('aborted', () => { if (!klaar) { s.destroy(); mis(fout(400, 'Upload afgebroken')); } });
    s.on('error', mis);
    s.on('finish', () => { klaar = true; ok(); });
    req.pipe(s);
  }).catch(async e => { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; });
  const m = Number(q.get('gewijzigd'));
  if (m > 0) await fsp.utimes(tmp, new Date(), new Date(m)).catch(() => {});
  await fsp.rename(tmp, doel);
  vergeetGrootte(doel, false);
  return { naam: path.relative(d.abs, doel).split(path.sep).join('/') };
}


/* ============================================================
   Films en series hernoemen via TMDB
   Los onderdeel: alleen namen binnen één map veranderen, nooit iets
   overschrijven, altijd eerst een voorstel, en alles terug te draaien.
   Zonder FM_TMDB staat dit uit en verandert er niets aan de rest.
   ============================================================ */
const VIDEO_EXT = new Set(['mkv', 'mp4', 'avi', 'm4v', 'mov', 'wmv', 'ts', 'm2ts', 'mpg', 'mpeg', 'webm']);
const BIJ_EXT = new Set(['srt', 'sub', 'idx', 'ass', 'ssa', 'vtt', 'nfo']);
const tmdbCache = new Map();   // url -> { tijd, data }
async function tmdb(pad, query = {}) {
  if (!CFG.tmdb) throw fout(501, 'TMDB staat uit (geen sleutel in de compose)');
  const token = CFG.tmdb.length > 60;   // lange code = Read Access Token, korte = API-sleutel
  const qs = new URLSearchParams(query);
  if (!token) qs.set('api_key', CFG.tmdb);
  const url = `${CFG.tmdbUrl}${pad}?${qs}`;
  const c = tmdbCache.get(url);
  if (c && Date.now() - c.tijd < 30 * 60 * 1000) return c.data;
  let r;
  try {
    r = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + CFG.tmdb, Accept: 'application/json' } : { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  } catch (e) { throw fout(504, 'TMDB is nu niet bereikbaar. Probeer het later opnieuw.'); }
  if (r.status === 401) throw fout(502, 'TMDB weigert de sleutel. Controleer FM_TMDB in de compose.');
  if (r.status === 404) throw fout(404, 'Niet gevonden bij TMDB');
  if (r.status === 429) throw fout(503, 'TMDB krijgt even te veel vragen. Probeer het zo opnieuw.');
  if (!r.ok) throw fout(502, `TMDB gaf een fout (${r.status})`);
  const data = await r.json();
  tmdbCache.set(url, { tijd: Date.now(), data });
  if (tmdbCache.size > 500) tmdbCache.delete(tmdbCache.keys().next().value);
  return data;
}
// alleen ons alfabet (met accenten), cijfers en leestekens
const latijns = t => /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{Zs}]*$/u.test(t || '');
function titelVan(x, soort) {
  const orig = soort === 'film' ? x.original_title : x.original_name;
  const eng = soort === 'film' ? x.title : x.name;
  return (orig && latijns(orig)) ? orig : (eng || orig || '');
}
const jaarVan = d => (/^(\d{4})/.exec(d || '') || [])[1] || '';
// veilige naam voor Windows, SMB en Linux
function schoneNaam(t) {
  let n = String(t).replace(/\s*:\s*/g, ' - ').replace(/[\\/?*"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  n = n.replace(/[. ]+$/, '');
  return n.slice(0, 200) || 'Naamloos';
}
// wat er in een mapnaam staat: titel, jaar en of het een serie lijkt
const RUIS = /\b(2160p|1080[pi]|720p|480p|4k|uhd|hdr10?\+?|dv|bluray|blu-ray|brrip|bdrip|web[- ]?dl|webrip|web|hdtv|dvdrip|dvd|remux|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|aac|ac3|dts(-hd)?|ddp?5\.1|atmos|truehd|10bit|proper|repack|extended|unrated|directors\.?cut|multi|nl|nlsubs|subs?|complete|integrale)\b.*$/i;
function raadUitNaam(naam) {
  let t = naam.replace(/\.(mkv|mp4|avi|m4v|mov)$/i, '').replace(/[._]+/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  const serie = /\bS\d{1,2}(E\d{1,3})?\b|\bseason\s*\d|\bseizoen\s*\d|\b\d{1,2}x\d{2}\b/i.test(t);
  t = t.replace(/\bS\d{1,2}(E\d{1,3})?\b.*$/i, '').replace(/\b(season|seizoen)\s*\d+.*$/i, '').replace(/\b\d{1,2}x\d{2}\b.*$/i, '');
  let jaar = '';
  const m = /^(.*?)[\s(]*\b(19[2-9]\d|20[0-4]\d)\b/.exec(t);
  if (m && m[1].trim()) { jaar = m[2]; t = m[1]; }
  t = t.replace(RUIS, '').replace(/[()\-]+\s*$/, '').replace(/\s+/g, ' ').trim();
  return { term: t, jaar, soort: serie ? 'serie' : 'film' };
}
// aflevering herkennen: S01E02, S01E02E03, 1x02, "S01 E02"
function aflevering(naam) {
  let m = /\bS(\d{1,2})\s*E(\d{1,3})(?:\s*-?\s*E(\d{1,3}))?/i.exec(naam);
  if (!m) m = /\b(\d{1,2})x(\d{2,3})\b/i.exec(naam);
  if (!m) return null;
  return { s: Number(m[1]), e: Number(m[2]), e2: m[3] ? Number(m[3]) : null };
}
const pad2 = n => String(n).padStart(2, '0');
const seizoenNr = naam => { const m = /^(?:season|seizoen|staffel|saison|temporada|series)\s*0*(\d{1,2})$|^s0*(\d{1,2})$/i.exec(naam.trim()); return m ? Number(m[1] ?? m[2]) : null; };
const seizoenMap = n => n === 0 ? 'Specials' : `Seizoen ${n}`;
// bijbestanden van een video: zelfde naam, plus bv. ".nl.srt" of ".nfo"
function bijbestanden(namen, video) {
  const basis = video.replace(/\.[^.]+$/, '');
  return namen.filter(n => n !== video && n.startsWith(basis + '.') && BIJ_EXT.has(ext(n))).map(n => ({ naam: n, staart: n.slice(basis.length) }));
}
async function mapInhoud(abs) {
  const uit = [];
  for (const d of await fsp.readdir(abs, { withFileTypes: true })) {
    if (d.name.startsWith('.') || d.name.endsWith(TIJDELIJK)) continue;
    if (d.isFile()) { const st = await fsp.stat(path.join(abs, d.name)).catch(() => null); uit.push({ naam: d.name, map: false, grootte: st ? st.size : 0 }); }
    else if (d.isDirectory()) uit.push({ naam: d.name, map: true });
  }
  return uit;
}
// startpunt: wat denken we dat het is, en de eerste zoekresultaten
async function tmdbStart(rel) {
  const p = await los(rel);
  if (p.isRoot) throw fout(400, 'Kies een map met een film of serie');
  const st = await fsp.stat(p.abs).catch(() => null);
  if (!st || !st.isDirectory()) throw fout(400, 'Dit werkt alleen op een map');
  const { mappen, videos } = await verzamel(p.abs);
  const r = raadUitNaam(p.naam);
  // series herkennen aan de bestanden (ook dieper): afleveringen of seizoensmappen
  if (videos.filter(v => aflevering(v.naam)).length >= Math.min(2, videos.length) && videos.some(v => aflevering(v.naam)) || [...mappen.keys()].some(m => m && seizoenUitMap(m.split('/').pop()) != null)) r.soort = 'serie';
  if (!r.term && videos[0]) Object.assign(r, raadUitNaam(videos[0].naam), { soort: r.soort });
  const resultaten = r.term ? await tmdbZoek(r.term, r.soort, r.jaar).catch(() => []) : [];
  return { ...r, resultaten };
}
async function tmdbZoek(term, soort, jaar) {
  term = String(term || '').trim();
  // een geplakte TMDB-link of -nummer: direct dat item
  const link = /themoviedb\.org\/(movie|tv)\/(\d+)/i.exec(term);
  if (link) return [await tmdbKort(link[1] === 'tv' ? 'serie' : 'film', link[2])];
  if (/^\d{1,9}$/.test(term)) return [await tmdbKort(soort, term)];
  if (term.length < 1) throw fout(400, 'Typ een titel');
  const q = { query: term.slice(0, 200), language: 'en-US', include_adult: 'false' };
  if (/^\d{4}$/.test(jaar || '')) q[soort === 'film' ? 'year' : 'first_air_date_year'] = jaar;
  const r = await tmdb(soort === 'film' ? '/search/movie' : '/search/tv', q);
  let lijst = (r.results || []).slice(0, 12);
  // met jaartal niets gevonden: nog eens zonder jaartal
  if (!lijst.length && q.year || !lijst.length && q.first_air_date_year) { delete q.year; delete q.first_air_date_year; lijst = ((await tmdb(soort === 'film' ? '/search/movie' : '/search/tv', q)).results || []).slice(0, 12); }
  return lijst.map(x => kortItem(x, soort));
}
function kortItem(x, soort) {
  const orig = soort === 'film' ? x.original_title : x.original_name;
  return { id: x.id, soort, titel: titelVan(x, soort), jaar: jaarVan(soort === 'film' ? x.release_date : x.first_air_date),
    origineel: orig || '', taal: x.original_language || '', poster: x.poster_path || null, uitleg: String(x.overview || '').slice(0, 220) };
}
async function tmdbKort(soort, id) {
  const x = await tmdb(soort === 'film' ? `/movie/${Number(id)}` : `/tv/${Number(id)}`, { language: 'en-US' });
  return kortItem(x, soort);
}
// het voorstel: lijst van stappen (oud -> nieuw), relatief aan de map zelf
// alles in een map tot een paar lagen diep: video's per map, en wat er in elke map staat
const MAX_DIEPTE = 4, MAX_VIDEOS = 3000;
async function verzamel(root) {
  const mappen = new Map();   // relatief pad ('' = de map zelf) -> inhoud
  const videos = [];
  const loop = async (rel, diepte) => {
    const inhoud = await mapInhoud(rel ? path.join(root, rel) : root).catch(() => []);
    mappen.set(rel, inhoud);
    for (const i of inhoud) {
      const r = rel ? rel + '/' + i.naam : i.naam;
      if (i.map) { if (diepte < MAX_DIEPTE) await loop(r, diepte + 1); }
      else if (VIDEO_EXT.has(ext(i.naam)) && videos.length < MAX_VIDEOS) videos.push({ rel: r, map: rel, naam: i.naam, grootte: i.grootte });
    }
  };
  await loop('', 0);
  return { mappen, videos };
}
const vergelijkNaam = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// hoort deze bestandsnaam bij deze serie? (geen titel in de naam = ja; een duidelijk andere titel = nee)
function zelfdeSerie(bestand, titels) {
  // afleveringsaanduidingen ("afl E01", "Episode 3") tellen niet als titel
  const t = vergelijkNaam(raadUitNaam(bestand).term.replace(/\b(?:e|ep|episode|afl|aflevering|deel|part)\s*\d+\b.*$/i, '').replace(/\b(?:afl|aflevering|episode|ep|deel|part)\b/gi, ''));
  if (t.length < 4) return true;
  return titels.some(x => { const v = vergelijkNaam(x); return v && (t.includes(v) || v.includes(t) || t.split(' ').slice(0, 2).join(' ') === v.split(' ').slice(0, 2).join(' ')); });
}
// seizoen uit een mapnaam halen, ook uit rommelige namen als "In de Vlaamsche pot S01-GP-TV" of "Season 1 720p"
function seizoenUitMap(naam) {
  const exact = seizoenNr(naam); if (exact != null) return exact;
  const m = /\b(?:season|seizoen|staffel|saison|temporada)\s*0*(\d{1,2})\b|\bS0*(\d{1,2})(?![\dE])/i.exec(naam.replace(/[._]+/g, ' '));
  return m ? Number(m[1] ?? m[2]) : null;
}
// het voorstel: lijst van stappen (oud -> nieuw), relatief aan de map zelf
async function tmdbVoorstel(rel, soort, id) {
  const p = await los(rel);
  if (p.isRoot) throw fout(400, 'Kies een map met een film of serie');
  const st = await fsp.stat(p.abs).catch(() => null);
  if (!st || !st.isDirectory()) throw fout(400, 'Dit werkt alleen op een map');
  if (!['film', 'serie'].includes(soort)) throw fout(400, 'Kies film of serie');
  const item = await tmdb(soort === 'film' ? `/movie/${Number(id)}` : `/tv/${Number(id)}`, { language: 'en-US' });
  const titel = schoneNaam(titelVan(item, soort));
  const jaar = jaarVan(soort === 'film' ? item.release_date : item.first_air_date);
  const mapNaam = schoneNaam(jaar ? `${titel} (${jaar})` : titel);
  const { mappen, videos } = await verzamel(p.abs);
  const inhoud = mappen.get('') || [];
  const namenIn = map => (mappen.get(map) || []).filter(i => !i.map).map(i => i.naam);
  const metMap = (map, naam) => map ? map + '/' + naam : naam;
  const stappen = [];        // { soort: 'bestand'|'map'|'nieuwemap'|'leegweg', van, naar } (paden binnen de map)
  const overgeslagen = [];   // { naam, reden }
  if (soort === 'film') {
    const echt = videos.filter(v => !/\bsample\b/i.test(v.naam)).sort((a, b) => b.grootte - a.grootte);
    // film in delen (cd1, cd2 / part1, part2) in dezelfde map: alle delen krijgen "Titel (jaar) - cd1"
    const deelNr = n => { const m = /(?:^|[ ._-])(?:cd|dis[ck]|part|pt)[ ._-]?([1-9])(?=[ ._-]|\.[^.]+$)/i.exec(n); return m ? Number(m[1]) : null; };
    const delen = echt.length ? echt.filter(v => v.map === echt[0].map && deelNr(v.naam) != null) : [];
    const inDelen = delen.length >= 2 && new Set(delen.map(v => deelNr(v.naam))).size === delen.length && delen.some(v => v === echt[0]);
    if (!echt.length) overgeslagen.push({ naam: p.naam, reden: 'geen videobestand gevonden; alleen de map wordt hernoemd' });
    else if (inDelen) {
      for (const v of delen.sort((a, b) => deelNr(a.naam) - deelNr(b.naam))) {
        const basis = `${mapNaam} - cd${deelNr(v.naam)}`;
        stappen.push({ soort: 'bestand', van: v.rel, naar: `${basis}.${ext(v.naam)}` });
        for (const b of bijbestanden(namenIn(v.map), v.naam)) stappen.push({ soort: 'bestand', van: metMap(v.map, b.naam), naar: basis + b.staart.toLowerCase() });
      }
      for (const o of echt.filter(v => !delen.includes(v))) overgeslagen.push({ naam: o.rel, reden: 'extra video, blijft zoals hij is' });
    } else {
      const v = echt[0];   // de grootste video is de film; die komt (met ondertitels) bovenin de map
      stappen.push({ soort: 'bestand', van: v.rel, naar: `${mapNaam}.${ext(v.naam)}` });
      for (const b of bijbestanden(namenIn(v.map), v.naam)) stappen.push({ soort: 'bestand', van: metMap(v.map, b.naam), naar: mapNaam + b.staart.toLowerCase() });
      for (const o of echt.slice(1)) overgeslagen.push({ naam: o.rel, reden: 'extra video, blijft zoals hij is' });
    }
    for (const o of videos.filter(v => /\bsample\b/i.test(v.naam))) overgeslagen.push({ naam: o.rel, reden: 'voorbeeldfragment (sample), blijft zoals hij is' });
  } else {
    const taal = item.original_language || 'en';
    const taalVoorTitels = latijns(item.original_name) ? taal : 'en-US';
    const titels = [item.name, item.original_name, titel];
    const seizoenen = new Map();   // nr -> afleveringen van TMDB
    // bestaande seizoensmappen direct in de map: die hernoemen we (in plaats van een tweede aan te maken)
    const mapVoorSeizoen = new Map();
    for (const i of inhoud) if (i.map) { const n = seizoenNr(i.naam); if (n != null && !mapVoorSeizoen.has(n)) mapVoorSeizoen.set(n, i.naam); }
    for (const v of videos) {
      if (!zelfdeSerie(v.naam, titels)) { overgeslagen.push({ naam: v.rel, reden: 'lijkt bij een andere serie te horen' }); continue; }
      let a = aflevering(v.naam);
      if (!a) {   // alleen een afleveringsnummer in de naam: seizoen uit de map (of een map erboven)
        const e = /\b[Ee](?:p(?:isode)?|fl(?:evering)?)?\s*0*(\d{1,3})\b/.exec(v.naam);
        const delen = v.map ? v.map.split('/') : [];
        let sz = null; for (let k = delen.length - 1; k >= 0 && sz == null; k--) sz = seizoenUitMap(delen[k]);
        if (e && sz != null) a = { s: sz, e: Number(e[1]), e2: null };
      }
      if (!a) { overgeslagen.push({ naam: v.rel, reden: 'geen seizoen en aflevering in de naam gevonden' }); continue; }
      if (!seizoenen.has(a.s)) {
        const s = await tmdb(`/tv/${Number(id)}/season/${a.s}`, { language: taalVoorTitels }).catch(() => null);
        seizoenen.set(a.s, s ? s.episodes || [] : null);
      }
      const eps = seizoenen.get(a.s);
      const ep = eps ? eps.find(x => x.episode_number === a.e) : null;
      const epTitel = ep && ep.name && !/^(episode|aflevering|épisode|folge|episodio|afsnit|avsnitt|jakso)\s*\d+$/i.test(ep.name.trim()) ? ep.name : '';
      const code = `S${pad2(a.s)}E${pad2(a.e)}${a.e2 ? '-E' + pad2(a.e2) : ''}`;
      const basis = schoneNaam(`${titel} ${code}${epTitel ? ' - ' + epTitel : ''}`);
      const doelMap = seizoenMap(a.s);
      stappen.push({ soort: 'bestand', van: v.rel, naar: `${doelMap}/${basis}.${ext(v.naam)}`, seizoen: a.s });
      for (const b of bijbestanden(namenIn(v.map), v.naam)) stappen.push({ soort: 'bestand', van: metMap(v.map, b.naam), naar: `${doelMap}/${basis}${b.staart.toLowerCase()}`, seizoen: a.s });
      if (!eps) overgeslagen.push({ naam: v.rel, reden: `seizoen ${a.s} niet gevonden bij TMDB, naam zonder afleveringstitel` });
    }
    // seizoensmappen: bestaande (direct in de map) hernoemen, ontbrekende aanmaken
    const nodig = [...new Set(stappen.filter(x => x.seizoen != null).map(x => x.seizoen))].sort((a, b) => a - b);
    const mapStappen = [];
    for (const n of nodig) {
      const bestaand = mapVoorSeizoen.get(n), doel = seizoenMap(n);
      if (bestaand && bestaand !== doel) mapStappen.push({ soort: 'map', van: bestaand, naar: doel });
      else if (!bestaand && !inhoud.some(i => i.map && i.naam === doel)) mapStappen.push({ soort: 'nieuwemap', van: null, naar: doel });
    }
    for (const x of stappen) {
      const m = mapStappen.find(ms => ms.soort === 'map' && x.van.startsWith(ms.van + '/'));
      if (m) x.van = m.naar + x.van.slice(m.van.length);
    }
    stappen.unshift(...mapStappen);
  }
  // stappen die niets veranderen weglaten; dubbele doelen en bestaande doelen markeren
  const echte = stappen.filter(x => x.van !== x.naar);
  const doelen = new Map();
  for (const x of echte) {
    if (x.soort === 'nieuwemap') continue;
    if (doelen.has(x.naar.toLowerCase())) { x.probleem = 'twee bestanden zouden dezelfde naam krijgen'; continue; }
    doelen.set(x.naar.toLowerCase(), x);
  }
  for (const x of echte) {
    if (x.probleem || x.soort !== 'bestand') continue;
    const doelAbs = path.join(p.abs, x.naar);
    if (await bestaat(doelAbs) && doelAbs.toLowerCase() !== path.join(p.abs, x.van).toLowerCase()) {
      if (!echte.some(y => y !== x && y.van === x.naar)) x.probleem = 'bestaat al, wordt overgeslagen';
    }
  }
  // tussenmappen die na het verplaatsen helemaal leeg zijn: opruimen (diepste eerst), zodat er geen lege rommel blijft
  const weg = new Set(echte.filter(x => x.soort === 'bestand' && !x.probleem).map(x => x.van));
  const behouden = new Set(echte.filter(x => x.soort === 'map').map(x => x.van));
  for (const n of echte.filter(x => x.soort !== 'bestand').map(x => x.naar)) behouden.add(n);
  const leeg = new Map();
  const wordtLeeg = map => {
    if (leeg.has(map)) return leeg.get(map);
    const r = map !== '' && !behouden.has(map) && (mappen.get(map) || []).every(i => i.map ? mappen.has(metMap(map, i.naam)) && wordtLeeg(metMap(map, i.naam)) : weg.has(metMap(map, i.naam)));
    leeg.set(map, r); return r;
  };
  const opruimen = [...mappen.keys()].filter(m => m && (mappen.get(m) || []).length >= 0 && [...weg].some(w => w.startsWith(m + '/')) && wordtLeeg(m));
  // alleen de bovenste lege map per tak tonen is overzichtelijker, maar we ruimen van diep naar ondiep op
  for (const m of opruimen.sort((a, b) => b.split('/').length - a.split('/').length)) echte.push({ soort: 'leegweg', van: m, naar: m });
  const nieuweMapNaam = mapNaam !== p.naam ? mapNaam : null;
  let mapProbleem = null;
  if (nieuweMapNaam) {
    const doel = path.join(path.dirname(p.abs), nieuweMapNaam);
    if (await bestaat(doel) && doel.toLowerCase() !== p.abs.toLowerCase()) mapProbleem = 'er staat al een map met deze naam, de map zelf blijft zoals hij is';
  }
  // restmappen: mappen direct in de map zonder video's of ondertitels (meer), die duidelijk bij deze film/serie horen
  const titelsVoorRest = soort === 'film' ? [item.title, item.original_title, titel] : [item.name, item.original_name, titel];
  const leegWeg = new Set(echte.filter(x => x.soort === 'leegweg').map(x => x.van));
  const restmappen = [];
  for (const i of inhoud) {
    if (!i.map || behouden.has(i.naam) || /^(Seizoen \d+|Specials)$/.test(i.naam)) continue;
    const uitDezeMap = [...weg].some(w => w.startsWith(i.naam + '/'));
    const hoortErbij = seizoenUitMap(i.naam) != null || (vergelijkNaam(raadUitNaam(i.naam).term).length >= 4 && zelfdeSerie(i.naam, titelsVoorRest));
    if (!uitDezeMap && !hoortErbij) continue;
    const r = await restInfo(path.join(p.abs, i.naam), i.naam, weg);
    if (!r) continue;
    // wordt de map toch al leeg opgeruimd? alleen melden als er verborgen bestanden in staan (.DS_Store e.d.), want dan lukt dat niet
    if (leegWeg.has(i.naam) && !r.aantal) continue;
    restmappen.push({ naam: i.naam, ...r });
  }
  return { map: p.rel, mapNaam: p.naam, nieuweMapNaam, mapProbleem, titel, jaar, soort, stappen: echte, overgeslagen, restmappen,
    tmdb: { id: Number(id), soort, titel: item.title || item.name, poster: item.poster_path || null } };
}
// wat staat er (nog) in een map, met verborgen bestanden; null als er een video of ondertitel achterblijft of als het te groot is
const REST_MAX = 200 * 1024 * 1024;
async function restInfo(abs, rel, weg) {
  let grootte = 0, aantal = 0; const voorbeeld = [];
  const loop = async (a, r, diepte) => {
    for (const d of await fsp.readdir(a, { withFileTypes: true })) {
      const ra = r + '/' + d.name, aa = path.join(a, d.name);
      if (d.isDirectory()) { if (diepte > 6) return false; if (await loop(aa, ra, diepte + 1) === false) return false; continue; }
      if (weg && weg.has(ra)) continue;                       // gaat er toch al uit
      const e = ext(d.name);
      if (VIDEO_EXT.has(e) || ['srt', 'sub', 'idx', 'ass', 'ssa', 'vtt'].includes(e)) return false;
      const st = await fsp.lstat(aa).catch(() => null);
      grootte += st && st.isFile() ? st.size : 0; aantal++;
      if (voorbeeld.length < 5) voorbeeld.push(d.name);
      if (grootte > REST_MAX || aantal > 2000) return false;
    }
  };
  try { if (await loop(abs, rel, 0) === false) return null; } catch { return null; }
  return { grootte, aantal, voorbeeld };
}
// restmappen na toestemming naar de prullenbak (kan via de prullenbak terug)
async function tmdbOpruimen(rel, namen) {
  if (hernoemBezig) throw fout(409, 'Er wordt nog iets hernoemd, probeer het zo opnieuw');
  const p = await los(rel);
  if (p.isRoot) throw fout(400, 'Ongeldige map');
  if (!Array.isArray(namen) || !namen.length) throw fout(400, 'Niets gekozen');
  const ids = [], fouten = [];
  for (const n of namen.slice(0, 200)) {
    if (naamFout(n)) { fouten.push(`${n}: ongeldige naam`); continue; }
    const abs = path.join(p.abs, n);
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st || !st.isDirectory()) { fouten.push(`${n}: niet gevonden`); continue; }
    // opnieuw controleren: er mag geen video of ondertitel meer in staan
    if (!(await restInfo(abs, n, null))) { fouten.push(`${n}: bevat nog video's of ondertitels, blijft staan`); continue; }
    try { ids.push(`${p.schijf}/${await naarPrullenbak(abs, p.root)}`); } catch (e) { fouten.push(`${n}: ${leesbaar(e)}`); }
  }
  log(`TMDB: ${ids.length} restmap(pen) naar de prullenbak in ${p.rel}`);
  return { ids, gelukt: ids.length, fouten };
}
// toepassen: het voorstel opnieuw berekenen (niet blind vertrouwen op wat de pagina stuurt) en stap voor stap uitvoeren
const hernoemLogBestand = path.join(CFG.data, 'tmdb-hernoemd.json');
function leesHernoemLog() { try { const j = JSON.parse(fs.readFileSync(hernoemLogBestand, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } }
async function bewaarHernoemLog(l) { const tmp = hernoemLogBestand + '.tmp'; await fsp.writeFile(tmp, JSON.stringify(l.slice(-50))); await fsp.rename(tmp, hernoemLogBestand); }
let hernoemBezig = false;
async function tmdbToepassen(rel, soort, id) {
  if (hernoemBezig) throw fout(409, 'Er wordt al iets hernoemd, probeer het zo opnieuw');
  hernoemBezig = true;
  try {
    const v = await tmdbVoorstel(rel, soort, id);
    const p = await los(rel);
    const binnen = x => { const a = path.resolve(p.abs, x); return a.startsWith(p.abs + path.sep); };
    const gedaan = [], fouten = [];
    for (const x of v.stappen) {
      if (x.probleem) { fouten.push(`${x.van || x.naar}: ${x.probleem}`); continue; }
      if (!binnen(x.naar) || (x.van && !binnen(x.van))) { fouten.push(`${x.van}: buiten de map, overgeslagen`); continue; }
      const naar = path.join(p.abs, x.naar);
      try {
        if (x.soort === 'nieuwemap') {
          if (!(await bestaat(naar))) { await fsp.mkdir(naar); gedaan.push({ soort: 'nieuwemap', naar: x.naar }); }
          continue;
        }
        if (x.soort === 'leegweg') {
          // rmdir weigert als er nog iets in staat (ook verborgen bestanden): dan blijft de map gewoon staan
          try { await fsp.rmdir(naar); gedaan.push({ soort: 'leegweg', naar: x.naar }); } catch {}
          continue;
        }
        const van = path.join(p.abs, x.van);
        if (!(await bestaat(van))) { fouten.push(`${x.van}: bestaat niet meer`); continue; }
        // nooit overschrijven (rename zou dat stilletjes doen); alleen hoofdletters veranderen mag wel
        if (await bestaat(naar) && naar.toLowerCase() !== van.toLowerCase()) { fouten.push(`${x.naar}: bestaat al, overgeslagen`); continue; }
        await fsp.mkdir(path.dirname(naar), { recursive: true });
        await fsp.rename(van, naar);
        gedaan.push({ soort: x.soort, van: x.van, naar: x.naar });
      } catch (e) { fouten.push(`${x.van || x.naar}: ${leesbaar(e)}`); }
    }
    // als laatste de map zelf
    let nieuwRel = p.rel;
    if (v.nieuweMapNaam && !v.mapProbleem) {
      const doel = path.join(path.dirname(p.abs), v.nieuweMapNaam);
      try {
        if (await bestaat(doel) && doel.toLowerCase() !== p.abs.toLowerCase()) fouten.push(`${v.nieuweMapNaam}: bestaat al`);
        else {
          await fsp.rename(p.abs, doel);
          nieuwRel = p.rel.split('/').slice(0, -1).concat(v.nieuweMapNaam).join('/');
          await favorietenHernoemd(p.rel, nieuwRel);
          await mapIconenHernoemd(p.rel, nieuwRel);
        }
      } catch (e) { fouten.push(`${p.naam}: ${leesbaar(e)}`); }
    } else if (v.mapProbleem) fouten.push(`${p.naam}: ${v.mapProbleem}`);
    vergeetGrootte(p.abs); if (nieuwRel !== p.rel) vergeetGrootte(path.join(CFG.schijven, ...nieuwRel.split('/')));
    const id_ = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    if (gedaan.length || nieuwRel !== p.rel) {
      const l = leesHernoemLog(); l.push({ id: id_, tijd: Date.now(), oudeMap: p.rel, map: nieuwRel, stappen: gedaan });
      await bewaarHernoemLog(l);
    }
    log(`TMDB: ${p.rel} → ${nieuwRel}, ${gedaan.length} stap(pen), ${fouten.length} melding(en)`);
    return { id: id_, map: nieuwRel, gedaan: gedaan.filter(x => x.soort === 'bestand').length, mapHernoemd: nieuwRel !== p.rel, fouten };
  } finally { hernoemBezig = false; }
}
// ongedaan maken: precies terug, in omgekeerde volgorde, en ook hier nooit iets overschrijven
async function tmdbTerug(id) {
  if (hernoemBezig) throw fout(409, 'Er wordt al iets hernoemd, probeer het zo opnieuw');
  hernoemBezig = true;
  try { return await tmdbTerugNu(id); } finally { hernoemBezig = false; }
}
async function tmdbTerugNu(id) {
  const l = leesHernoemLog();
  const i = l.findIndex(x => x.id === id);
  if (i < 0) throw fout(404, 'Deze hernoeming kan niet meer ongedaan gemaakt worden');
  const r = l[i];
  const fouten = [];
  let mapAbs = (await los(r.map)).abs;
  if (!(await bestaat(mapAbs))) throw fout(404, `De map "${r.map.split('/').pop()}" is er niet meer (verplaatst of hernoemd), ongedaan maken kan niet`);
  if (r.map !== r.oudeMap) {
    const oud = (await los(r.oudeMap).catch(() => null));
    const oudAbs = oud ? oud.abs : path.join(path.dirname(mapAbs), r.oudeMap.split('/').pop());
    if (await bestaat(oudAbs) && oudAbs.toLowerCase() !== mapAbs.toLowerCase()) fouten.push(`${r.oudeMap}: bestaat al, map niet teruggezet`);
    else if (!oud) fouten.push(`${r.oudeMap}: schijf niet bereikbaar, map niet teruggezet`);
    else { await fsp.rename(mapAbs, oudAbs); await favorietenHernoemd(r.map, r.oudeMap); await mapIconenHernoemd(r.map, r.oudeMap); mapAbs = oudAbs; }
  }
  for (const x of [...r.stappen].reverse()) {
    try {
      if (x.soort === 'nieuwemap') { await fsp.rmdir(path.join(mapAbs, x.naar)).catch(() => {}); continue; }
      if (x.soort === 'leegweg') { await fsp.mkdir(path.join(mapAbs, x.naar), { recursive: true }); continue; }
      const nu = path.join(mapAbs, x.naar), terug = path.join(mapAbs, x.van);
      if (!(await bestaat(nu))) { fouten.push(`${x.naar}: niet meer gevonden`); continue; }
      if (await bestaat(terug) && nu.toLowerCase() !== terug.toLowerCase()) { fouten.push(`${x.van}: bestaat al, niet teruggezet`); continue; }
      await fsp.mkdir(path.dirname(terug), { recursive: true });
      await fsp.rename(nu, terug);
    } catch (e) { fouten.push(`${x.naar}: ${leesbaar(e)}`); }
  }
  l.splice(i, 1); await bewaarHernoemLog(l);
  vergeetGrootte(mapAbs);
  log(`TMDB: ongedaan gemaakt (${r.map} → ${r.oudeMap})`);
  return { map: r.oudeMap, fouten };
}
// posters via de eigen server (de pagina mag zelf geen andere sites laden)
async function tmdbPoster(req, res, p) {
  if (!CFG.tmdb) throw fout(501, 'TMDB staat uit');
  if (!/^\/[A-Za-z0-9_-]{5,64}\.(jpg|png)$/.test(p || '')) throw fout(400, 'Ongeldig');
  let r;
  try { r = await fetch(`${CFG.tmdbBeeld}/w92${p}`, { signal: AbortSignal.timeout(10000) }); } catch { throw fout(504, 'Poster niet bereikbaar'); }
  if (!r.ok) throw fout(404, 'Geen poster');
  const b = Buffer.from(await r.arrayBuffer());
  res.writeHead(200, { 'Content-Type': p.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Content-Length': b.length, 'Cache-Control': 'private, max-age=604800' });
  res.end(b);
}

/* ============================================================
   Nederlandse ondertitels via OpenSubtitles.com
   Los onderdeel: zoeken in een map (een paar lagen diep) of bij één video,
   jij kiest wat er gedownload wordt, nooit iets overschrijven.
   Zonder FM_OS_KEY staat dit uit en verandert er niets aan de rest.
   ============================================================ */
const SUB_EXT = new Set(['srt', 'sub', 'idx', 'ass', 'ssa', 'vtt']);
const OS_MAX_VIDEOS = 150;
const os = { token: null, tokenTijd: 0, basis: null, inloggen: null, rij: Promise.resolve(), laatste: 0, cache: new Map(), over: null, reset: null };
// rustig aan: hooguit ongeveer 4 verzoeken per seconde (de grens is 40 per 10 seconden)
function osBeurt() {
  const beurt = os.rij.then(async () => { const w = os.laatste + 250 - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); os.laatste = Date.now(); });
  os.rij = beurt.catch(() => {});
  return beurt;
}
const osKoppen = extra => ({ 'Api-Key': CFG.osSleutel, 'User-Agent': 'FilesWeb v1.0', Accept: 'application/json', ...extra });
async function osLogin(opnieuw = false) {
  if (!CFG.osGebruiker || !CFG.osWachtwoord) return null;
  if (!opnieuw && os.token && Date.now() - os.tokenTijd < 12 * 3600 * 1000) return os.token;
  if (os.inloggen) return os.inloggen;
  os.inloggen = (async () => {
    await osBeurt();
    let r;
    try { r = await fetch(CFG.osUrl + '/login', { method: 'POST', headers: osKoppen({ 'Content-Type': 'application/json' }), body: JSON.stringify({ username: CFG.osGebruiker, password: CFG.osWachtwoord }), signal: AbortSignal.timeout(15000) }); }
    catch { throw fout(504, 'OpenSubtitles is nu niet bereikbaar. Probeer het later opnieuw.'); }
    if (r.status === 401) throw fout(502, 'OpenSubtitles weigert de gebruikersnaam of het wachtwoord. Controleer FM_OS_USER en FM_OS_PASS in de compose.');
    if (r.status === 403) throw fout(502, 'OpenSubtitles weigert de API-sleutel. Controleer FM_OS_KEY in de compose.');
    if (r.status === 429) throw fout(503, 'OpenSubtitles krijgt even te veel vragen. Probeer het over een minuut opnieuw.');
    if (!r.ok) throw fout(502, `OpenSubtitles gaf een fout bij inloggen (${r.status})`);
    const j = await r.json();
    os.token = j.token; os.tokenTijd = Date.now();
    // VIP-accounts krijgen een eigen server
    os.basis = j.base_url && /^[a-z0-9.-]+$/i.test(j.base_url) && !/^api\.opensubtitles\.com$/i.test(j.base_url) && /^https:\/\/api\.opensubtitles\.com\//.test(CFG.osUrl + '/') ? `https://${j.base_url}/api/v1` : null;
    return os.token;
  })();
  try { return await os.inloggen; } finally { os.inloggen = null; }
}
async function osApi(pad, { query, body, token = false, poging = 0 } = {}) {
  if (!CFG.osSleutel) throw fout(501, 'Ondertitels staan uit (geen sleutel in de compose)');
  let url = (os.basis || CFG.osUrl) + pad;
  if (query) {
    // OpenSubtitles wil de parameters op alfabet en in kleine letters (anders een omleiding)
    const qs = Object.keys(query).filter(k => query[k] != null && query[k] !== '').sort().map(k => `${k}=${encodeURIComponent(String(query[k]).toLowerCase())}`).join('&');
    url += '?' + qs;
    const c = os.cache.get(url);
    if (c && Date.now() - c.tijd < 30 * 60 * 1000) return c.data;
  }
  const t = token ? await osLogin() : null;
  await osBeurt();
  let r;
  try {
    r = await fetch(url, { method: body ? 'POST' : 'GET', headers: osKoppen({ ...(body ? { 'Content-Type': 'application/json' } : {}), ...(t ? { Authorization: 'Bearer ' + t } : {}) }), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  } catch { throw fout(504, 'OpenSubtitles is nu niet bereikbaar. Probeer het later opnieuw.'); }
  if (r.status === 401 && t && poging === 0) { await osLogin(true); return osApi(pad, { query, body, token, poging: 1 }); }
  if ((r.status === 429 || r.status === 502) && poging === 0) { await new Promise(x => setTimeout(x, r.status === 429 ? 2000 : 5000)); return osApi(pad, { query, body, token, poging: 1 }); }
  let j = null; try { j = await r.json(); } catch {}
  if (r.status === 406) {
    if (j && typeof j.remaining === 'number') os.over = j.remaining;
    if (j && j.reset_time_utc) os.reset = j.reset_time_utc;
    throw fout(429, 'Je dagtegoed bij OpenSubtitles is op' + (j && j.reset_time ? ` (weer aangevuld over ${j.reset_time})` : '') + '.');
  }
  if (r.status === 401) throw fout(502, 'OpenSubtitles weigert de inlog. Controleer FM_OS_USER en FM_OS_PASS in de compose.');
  if (r.status === 403) throw fout(502, 'OpenSubtitles weigert de API-sleutel. Controleer FM_OS_KEY in de compose.');
  if (r.status === 429) throw fout(503, 'OpenSubtitles krijgt even te veel vragen. Probeer het over een minuut opnieuw.');
  if (r.status === 410) throw fout(502, 'Deze ondertitel is niet meer beschikbaar');
  if (!r.ok || !j) throw fout(502, `OpenSubtitles gaf een fout (${r.status})`);
  if (query) { os.cache.set(url, { tijd: Date.now(), data: j }); if (os.cache.size > 800) os.cache.delete(os.cache.keys().next().value); }
  return j;
}
// vingerafdruk van een video zoals OpenSubtitles die gebruikt: grootte + som van de eerste en laatste 64 kB
async function osHash(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const { size } = await fh.stat();
    const blok = 65536, M = (1n << 64n) - 1n;
    let h = BigInt(size);
    const lees = async pos => {
      const buf = Buffer.alloc(blok);
      const { bytesRead } = await fh.read(buf, 0, Math.min(blok, size), pos);
      for (let i = 0; i + 8 <= bytesRead; i += 8) h = (h + buf.readBigUInt64LE(i)) & M;
    };
    await lees(0); await lees(Math.max(0, size - blok));
    return h.toString(16).padStart(16, '0');
  } finally { await fh.close(); }
}
// heeft deze video al een Nederlandse ondertitel naast zich? (Film.nl.srt, Film.nld.srt, Film.dut.forced.srt, Film.Dutch.srt …)
function heeftNlSub(namen, video) {
  const basis = video.replace(/\.[^.]+$/, '');
  return namen.some(n => n !== video && n.startsWith(basis + '.') && SUB_EXT.has(ext(n)) && /\.(nl|nld|dut|dutch|nederlands)(\.|$)/i.test(n.slice(basis.length)));
}
// wat zoeken we: film (titel, jaar) of aflevering (serie, seizoen, aflevering)
function osWat(v, kaders) {
  let afl = aflevering(v.naam);
  // alleen "E01" in de naam: seizoen uit de map erboven
  if (!afl) { const m = /\bE(\d{1,3})\b/i.exec(v.naam.replace(/[._]+/g, ' ')); const sz = kaders.length ? seizoenUitMap(kaders[0]) : null; if (m && sz != null) afl = { s: sz, e: Number(m[1]) }; }
  if (afl) {
    let serie = raadUitNaam(v.naam).term.replace(/\b(?:e|ep|episode|afl|aflevering|deel|part)\s*\d+\b.*$/i, '').replace(/\b(?:afl|aflevering|episode|ep|deel|part)\b/gi, '').trim();
    // geen titel in de bestandsnaam: uit de mappen erboven (kale seizoensmappen overslaan)
    for (const k of kaders) { if (vergelijkNaam(serie).length >= 2) break; if (seizoenNr(k) != null) continue; serie = raadUitNaam(k).term; }
    return { soort: 'serie', term: serie, s: afl.s, e: afl.e };
  }
  let r = raadUitNaam(v.naam);
  if (vergelijkNaam(r.term).length < 3 || /^(movie|film|video|sample)$/i.test(r.term)) r = raadUitNaam(kaders[0] || r.term);
  return { soort: 'film', term: r.term, jaar: r.jaar };
}
function osKandidaat(d) {
  const a = d.attributes || {}, f = (a.files || [])[0];
  if (!f || !f.file_id) return null;
  const fd = a.feature_details || {};
  return { id: f.file_id, release: String(a.release || f.file_name || '').slice(0, 160), downloads: a.download_count || 0,
    hash: !!a.moviehash_match, doven: !!a.hearing_impaired, machine: !!(a.machine_translated || a.ai_translated), vertrouwd: !!a.from_trusted,
    uploader: a.uploader && a.uploader.name ? String(a.uploader.name).slice(0, 40) : '', titel: fd.parent_title || fd.movie_name || fd.title || '', jaar: fd.year || null,
    s: fd.season_number ?? null, e: fd.episode_number ?? null };
}
// beste eerst: past precies (hash), geen machinevertaling, geen doven/slechthorenden-versie, meest gedownload
const osVolgorde = (a, b) => (b.hash - a.hash) || (a.machine - b.machine) || (a.doven - b.doven) || (b.vertrouwd - a.vertrouwd) || (b.downloads - a.downloads);
async function osZoekVideo(abs, v, wat) {
  const lijst = new Map();
  const voeg = (data, filter) => { for (const d of (data && data.data) || []) { const k = osKandidaat(d); if (!k || (filter && !filter(k))) continue; const o = lijst.get(k.id); if (!o) lijst.set(k.id, k); else o.hash = o.hash || k.hash; } };
  const hash = await osHash(abs).catch(() => null);
  if (hash) voeg(await osApi('/subtitles', { query: { languages: 'nl', moviehash: hash } }), k => k.hash);
  const id = wat.id || {};   // zelf opgegeven IMDb- of TMDB-nummer
  if (id.imdb || id.tmdb) {
    const sleutel = wat.soort === 'serie' ? (id.imdb ? { parent_imdb_id: id.imdb } : { parent_tmdb_id: id.tmdb }) : (id.imdb ? { imdb_id: id.imdb } : { tmdb_id: id.tmdb });
    if (wat.soort === 'serie') {
      for (let page = 1; page <= 3; page++) {
        const r = await osApi('/subtitles', { query: { languages: 'nl', ...sleutel, season_number: wat.s, episode_number: wat.e, page } });
        voeg(r, k => k.e == null || k.e === wat.e);
        if (!r.total_pages || page >= r.total_pages) break;
      }
    } else voeg(await osApi('/subtitles', { query: { languages: 'nl', ...sleutel } }));
  } else if (vergelijkNaam(wat.term).length >= 2) {
    if (wat.soort === 'serie') {
      // per seizoen één keer zoeken (gedeeld door alle afleveringen), dan op aflevering filteren
      for (let page = 1; page <= 3; page++) {
        const r = await osApi('/subtitles', { query: { languages: 'nl', query: wat.term, season_number: wat.s, type: 'episode', page } });
        voeg(r, k => k.e === wat.e && (k.s == null || k.s === wat.s));
        if (!r.total_pages || page >= r.total_pages) break;
      }
    } else {
      voeg(await osApi('/subtitles', { query: { languages: 'nl', query: wat.term, type: 'movie', year: wat.jaar || null } }), k => !wat.jaar || !k.jaar || Math.abs(k.jaar - Number(wat.jaar)) <= 1);
    }
  }
  return [...lijst.values()].sort(osVolgorde).slice(0, 12);
}
// zoeken loopt als taak op de achtergrond; het venster vraagt de voortgang op
const osZoektaken = new Map();
async function osStart(rel) {
  if (!CFG.osSleutel) throw fout(501, 'Ondertitels staan uit (geen sleutel in de compose)');
  const p = await los(rel);
  if (p.isRoot) throw fout(400, 'Kies een map of video');
  const st = await fsp.stat(p.abs).catch(() => null);
  if (!st) throw fout(404, 'Niet gevonden');
  let basis, videos, mappen;
  if (st.isDirectory()) { basis = p; ({ videos, mappen } = await verzamel(p.abs)); }
  else {
    if (!VIDEO_EXT.has(ext(p.naam))) throw fout(400, 'Dit werkt op een map of een video');
    basis = await los(rel.split('/').slice(0, -1).join('/'));
    videos = [{ rel: p.naam, map: '', naam: p.naam, grootte: st.size }];
    mappen = new Map([['', await mapInhoud(basis.abs)]]);
  }
  videos = videos.filter(v => !/(^|[ ._-])sample([ ._-]|$)/i.test(v.naam) && !/(^|\/)samples?$/i.test(v.map)).sort((a, b) => a.rel.localeCompare(b.rel, 'nl', { numeric: true }));
  const id = crypto.randomBytes(8).toString('hex');
  const taak = { id, basis: basis.rel, klaar: false, gestopt: false, totaal: Math.min(videos.length, OS_MAX_VIDEOS), meer: Math.max(0, videos.length - OS_MAX_VIDEOS), gedaan: 0, items: [], fout: null, tijd: Date.now() };
  osZoektaken.set(id, taak);
  for (const [k, t] of osZoektaken) if (Date.now() - t.tijd > 3600 * 1000) osZoektaken.delete(k);
  (async () => {
    // eerst inloggen, dan klopt het dagtegoed meteen (fouten hierbij melden we straks bij downloaden)
    try {
      if (await osLogin()) {
        const u = await osApi('/infos/user', { token: true });
        if (u && u.data && typeof u.data.remaining_downloads === 'number') os.over = u.data.remaining_downloads;
      }
    } catch (e) { taak.waarschuwing = e.message; }
    for (const v of videos.slice(0, OS_MAX_VIDEOS)) {
      if (taak.gestopt) break;
      const namen = (mappen.get(v.map) || []).map(i => i.naam);
      const item = { video: v.rel, naam: v.naam, doel: v.rel.replace(/\.[^.]+$/, '') + '.nl.srt', kandidaten: [] };
      if (heeftNlSub(namen, v.naam)) item.al = true;
      else {
        const kaders = [];
        const delen = v.map ? v.map.split('/') : [];
        for (let i = delen.length - 1; i >= 0; i--) kaders.push(delen[i]);
        kaders.push(basis.naam);
        item.wat = osWat(v, kaders);
        try { item.kandidaten = await osZoekVideo(path.join(basis.abs, v.rel), v, item.wat); }
        catch (e) { item.fout = e.message; if (!(e instanceof Fout) || e.code >= 500) { taak.fout = item.fout = e instanceof Fout ? e.message : leesbaar(e); taak.items.push(item); taak.gedaan++; break; } }
      }
      taak.items.push(item); taak.gedaan++;
    }
    taak.klaar = true;
  })().catch(e => { taak.fout = leesbaar(e); taak.klaar = true; });
  return { id, totaal: taak.totaal };
}
// zelf zoeken voor één video: andere titel, jaar, seizoen/aflevering, of een IMDb-/TMDB-link
async function osHandZoek(rel, video, term, jaar, s, e) {
  if (!CFG.osSleutel) throw fout(501, 'Ondertitels staan uit (geen sleutel in de compose)');
  const basis = await los(rel);
  const delen = String(video || '').split('/');
  if (!video || delen.some(d => naamFout(d)) || !VIDEO_EXT.has(ext(String(video)))) throw fout(400, 'Ongeldige video');
  const vAbs = path.join(basis.abs, ...delen);
  if (!(await binnenSchijf(vAbs, basis.root)) || !(await bestaat(vAbs))) throw fout(404, 'Video niet gevonden');
  term = String(term || '').trim().slice(0, 200);
  const sn = s === '' || s == null ? null : Number(s), en = e === '' || e == null ? null : Number(e);
  const serie = Number.isInteger(sn) && Number.isInteger(en) && sn >= 0 && sn < 100 && en > 0 && en < 1000;
  const wat = { soort: serie ? 'serie' : 'film', term, jaar: /^(19|20)\d\d$/.test(String(jaar || '')) ? String(jaar) : '', s: sn, e: en, id: {} };
  const imdb = /\btt0*(\d{4,10})\b/i.exec(term), tm = /themoviedb\.org\/(movie|tv)\/(\d+)/i.exec(term);
  if (imdb) wat.id.imdb = imdb[1];
  else if (tm) { wat.id.tmdb = tm[2]; if (tm[1] === 'tv' && !serie) throw fout(400, 'Vul bij een serie ook seizoen en aflevering in'); }
  else if (vergelijkNaam(term).length < 2) throw fout(400, 'Typ een titel, of plak een IMDb- of TMDB-link');
  const kandidaten = await osZoekVideo(vAbs, { naam: delen.at(-1) }, wat);
  return { kandidaten, over: os.over };
}
function osVoortgang(id, vanaf) {
  const t = osZoektaken.get(String(id));
  if (!t) throw fout(404, 'Deze zoekopdracht bestaat niet meer');
  const n = Math.max(0, Number(vanaf) || 0);
  return { klaar: t.klaar, gedaan: t.gedaan, totaal: t.totaal, meer: t.meer, items: t.items.slice(n), fout: t.fout, waarschuwing: t.waarschuwing || null, over: os.over, ingelogd: !!os.token };
}
// tekst van een ondertitel netjes als UTF-8 (oude bestanden zijn vaak Windows-1252)
function alsUtf8(buf) {
  let t;
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf).replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf); b.swap16(); return new TextDecoder('utf-16le').decode(b).replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n'); }
  try { t = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { try { t = new TextDecoder('windows-1252').decode(buf); } catch { t = buf.toString('latin1'); } }
  return t.replace(/^﻿/, '').replace(/\r?\n/g, '\r\n');
}
let osDownloadBezig = false;
async function osDownload(rel, keuzes) {
  if (osDownloadBezig) throw fout(409, 'Er wordt al gedownload, wacht even tot dat klaar is');
  osDownloadBezig = true;
  try { return await osDownloadNu(rel, keuzes); } finally { osDownloadBezig = false; }
}
async function osDownloadNu(rel, keuzes) {
  const basis = await los(rel);
  if (!Array.isArray(keuzes) || !keuzes.length) throw fout(400, 'Niets gekozen');
  const gedaan = [], fouten = [];
  for (const k of keuzes.slice(0, 60)) {
    const video = String(k.video || '');
    const delen = video.split('/');
    if (!video || delen.some(d => naamFout(d)) || !VIDEO_EXT.has(ext(video)) || !Number.isInteger(k.id)) { fouten.push(`${video}: ongeldig`); continue; }
    const vAbs = path.join(basis.abs, ...delen);
    if (!(await binnenSchijf(vAbs, basis.root)) || !(await bestaat(vAbs))) { fouten.push(`${delen.at(-1)}: video niet gevonden`); continue; }
    const doelNaam = delen.at(-1).replace(/\.[^.]+$/, '') + '.nl.srt';
    const doel = path.join(path.dirname(vAbs), doelNaam);
    if (await bestaat(doel)) { fouten.push(`${doelNaam}: bestaat al, overgeslagen`); continue; }
    // vóór het downloaden controleren (een download kost dagtegoed): al een Nederlandse ondertitel, of map niet schrijfbaar?
    const naast = await fsp.readdir(path.dirname(vAbs)).catch(() => []);
    if (heeftNlSub(naast, delen.at(-1))) { fouten.push(`${delen.at(-1)}: heeft al een Nederlandse ondertitel, overgeslagen`); continue; }
    try { await fsp.access(path.dirname(vAbs), fs.constants.W_OK); } catch { fouten.push(`${delen.at(-1)}: deze map is alleen-lezen, niets gedownload`); continue; }
    try {
      const d = await osApi('/download', { body: { file_id: k.id, sub_format: 'srt' }, token: true });
      if (typeof d.remaining === 'number') os.over = d.remaining;
      if (d.reset_time_utc) os.reset = d.reset_time_utc;
      if (!d.link || !/^https?:\/\//.test(d.link)) throw fout(502, 'OpenSubtitles gaf geen downloadlink');
      let r;
      try { r = await fetch(d.link, { headers: { 'User-Agent': 'FilesWeb v1.0' }, signal: AbortSignal.timeout(20000) }); }
      catch { throw fout(504, 'Downloaden mislukt, OpenSubtitles is niet bereikbaar'); }
      if (!r.ok) throw fout(502, `Downloaden mislukt (${r.status})`);
      if (Number(r.headers.get('content-length')) > 3 * 1024 * 1024) throw fout(502, 'Het ondertitelbestand is te groot');
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > 3 * 1024 * 1024) throw fout(502, 'Het ondertitelbestand is leeg of te groot');
      const tekst = alsUtf8(buf);
      if (!/-->/.test(tekst)) throw fout(502, 'Dit lijkt geen geldige ondertitel');
      await fsp.writeFile(doel, tekst, { flag: 'wx' });   // wx: nooit overschrijven
      vergeetGrootte(doel, false);
      gedaan.push(path.posix.join(path.posix.dirname(video), doelNaam).replace(/^\.\//, ''));
    } catch (e) {
      fouten.push(`${delen.at(-1)}: ${e instanceof Fout ? e.message : leesbaar(e)}`);
      if (e.code === 429 || e.code === 501 || (e.code === 502 && /weigert/.test(e.message))) break;   // tegoed op of sleutel fout: stoppen
    }
  }
  log(`Ondertitels: ${gedaan.length} gedownload in ${basis.rel}, ${fouten.length} melding(en)`);
  return { pad: basis.rel, gedaan, fouten, over: os.over, reset: os.reset };
}
async function osStatus() {
  if (!CFG.osSleutel) return { aan: false };
  return { aan: true, account: !!(CFG.osGebruiker && CFG.osWachtwoord), over: os.over };
}

/* ---------- Tekstbestanden bewerken (json, yaml, conf …) ----------
   Alleen UTF-8-tekst tot 2 MB. Opslaan schrijft in hetzelfde bestand (zelfde inode), zodat eigenaar,
   rechten en koppelingen in andere containers (een losse config die in een container is gemount) blijven werken.
   Vóór het schrijven gaat de vorige versie naar /data/tekst-vorige, en het bestand mag intussen niet veranderd zijn. */
const TEKST_MAX = 2 * 1024 * 1024;
const vorigeMap = path.join(CFG.data, 'tekst-vorige');
async function tekstBestand(rel) {
  const p = await los(rel);
  if (p.isRoot) throw fout(400, 'Kies een bestand');
  const lst = await fsp.lstat(p.abs).catch(() => null);
  if (!lst) throw fout(404, 'Dit bestand bestaat niet (meer)');
  if (lst.isSymbolicLink()) throw fout(400, 'Dit is een snelkoppeling; open het bestand waar hij naar wijst');
  if (!lst.isFile()) throw fout(400, 'Dit is geen bestand');
  return { p, st: lst };
}
async function leesTekst(rel) {
  const { p, st } = await tekstBestand(rel);
  if (st.size > TEKST_MAX) throw fout(413, 'Dit bestand is te groot om hier te bewerken (maximaal 2 MB)');
  const buf = await fsp.readFile(p.abs);
  if (buf.includes(0)) throw fout(415, 'Dit lijkt geen tekstbestand');
  let inhoud;
  try { inhoud = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); }
  catch { throw fout(415, 'Dit bestand is geen gewone (UTF-8) tekst en kan hier niet veilig bewerkt worden'); }
  const bom = inhoud.startsWith('﻿');
  let schrijfbaar = true;
  try { await fsp.access(p.abs, fs.constants.W_OK); } catch { schrijfbaar = false; }
  return { inhoud: bom ? inhoud.slice(1) : inhoud, bom, mtime: st.mtimeMs, grootte: st.size, schrijfbaar };
}
async function bewaarTekst(rel, inhoud, mtime, bom) {
  if (typeof inhoud !== 'string') throw fout(400, 'Geen tekst');
  const data = Buffer.from((bom ? '﻿' : '') + inhoud, 'utf8');
  if (data.length > TEKST_MAX) throw fout(413, 'De tekst is te groot (maximaal 2 MB)');
  const { p, st } = await tekstBestand(rel);
  if (typeof mtime !== 'number' || Math.abs(st.mtimeMs - mtime) > 1) throw fout(409, 'Dit bestand is intussen ergens anders gewijzigd. Sluit de editor en open het opnieuw (kopieer je wijzigingen eerst als je ze wilt bewaren).');
  // vorige versie bewaren (buiten de schijf, max. 2 MB per bestand, alleen de laatste per bestand)
  const sleutel = crypto.createHash('sha1').update(p.abs).digest('hex').slice(0, 16);
  try { await fsp.mkdir(vorigeMap, { recursive: true }); await fsp.copyFile(p.abs, path.join(vorigeMap, sleutel)); } catch (e) { log('Kon vorige versie niet bewaren:', e.message); }
  // in hetzelfde bestand schrijven: eerst de nieuwe inhoud, dan inkorten, dan echt naar de schijf
  const fh = await fsp.open(p.abs, 'r+');
  try {
    let pos = 0;
    while (pos < data.length) { const { bytesWritten } = await fh.write(data, pos, data.length - pos, pos); pos += bytesWritten; }
    await fh.truncate(data.length);
    await fh.datasync().catch(() => {});
  } finally { await fh.close(); }
  vergeetGrootte(p.abs, false);
  const na = await fsp.stat(p.abs);
  log(`Tekst opgeslagen: ${p.rel} (${data.length} bytes)`);
  return { mtime: na.mtimeMs, grootte: na.size };
}
// oude reservekopieën opruimen (ouder dan 30 dagen)
setTimeout(async () => {
  try { for (const n of await fsp.readdir(vorigeMap)) { const a = path.join(vorigeMap, n); const s2 = await fsp.stat(a); if (Date.now() - s2.mtimeMs > 30 * 864e5) await fsp.rm(a, { force: true }); } } catch {}
}, 120000).unref();

const ROUTES = {
  'GET /api/tmdb/status': async () => ({ aan: !!CFG.tmdb }),
  'GET /api/tmdb/start': async (req, q) => tmdbStart(q.get('pad') || ''),
  'GET /api/tmdb/zoek': async (req, q) => ({ resultaten: await tmdbZoek(q.get('q'), q.get('soort') === 'serie' ? 'serie' : 'film', q.get('jaar')) }),
  'POST /api/tmdb/voorstel': async (req, q, b) => tmdbVoorstel(b.pad || '', b.soort, b.id),
  'POST /api/tmdb/toepassen': async (req, q, b) => tmdbToepassen(b.pad || '', b.soort, b.id),
  'POST /api/tmdb/terug': async (req, q, b) => tmdbTerug(String(b.id || '')),
  'POST /api/tmdb/opruimen': async (req, q, b) => tmdbOpruimen(b.pad || '', b.mappen),
  'GET /api/os/status': async () => osStatus(),
  'POST /api/os/zoek': async (req, q, b) => osStart(b.pad || ''),
  'GET /api/os/voortgang': async (req, q) => osVoortgang(q.get('id'), q.get('vanaf')),
  'POST /api/os/handzoek': async (req, q, b) => osHandZoek(b.pad || '', b.video, b.term, b.jaar, b.s, b.e),
  'POST /api/os/stop': async (req, q, b) => { const t = osZoektaken.get(String(b.id || '')); if (t) t.gestopt = true; return { ok: true }; },
  'POST /api/os/download': async (req, q, b) => osDownload(b.pad || '', b.keuzes),
  'GET /api/schijven': async () => ({ schijven: await schijven() }),
  'GET /api/mogelijkheden': async () => ({ versie: VERSIE, videoMini: !!(GEREEDSCHAP.ffmpeg && GEREEDSCHAP.vipsthumbnail) }),
  'GET /api/tekst': async (req, q) => leesTekst(q.get('pad') || ''),
  'POST /api/tekst': async (req, q, b) => bewaarTekst(b.pad || '', b.inhoud, b.mtime, !!b.bom),
  'GET /api/lijst': async (req, q) => {
    const rel = q.get('pad') || '';
    return { items: await lijst(rel, q.get('verborgen') === '1') };
  },
  'GET /api/groottes': async (req, q) => groottesVoor((await los(q.get('pad') || '')).abs),
  'GET /api/eigenschappen': async (req, q) => eigenschappen(q.get('pad') || ''),
  'GET /api/taken': async () => ({ taken: taken.map(taakVoorClient), nu: Date.now() }),
  'GET /api/prullenbak': async () => ({ items: await prullenbakLijst() }),
  'GET /api/favorieten': async () => ({ favorieten: await favorietenMetStatus() }),
  'GET /api/mapiconen': async () => ({ iconen: leesMapIconen() }),
  'POST /api/mapicoon': async (req, q, b) => zetMapIcoon(b),
  'GET /api/grootste': async (req, q) => grootsteMappen(q.get('pad') || '', Number(q.get('aantal')) || 25),
  'POST /api/favorieten': async (req, q, b) => wijzigFavorieten(b),
  'POST /api/conflicten': async (req, q, b) => ({ conflicten: await conflicten(Array.isArray(b.namen) ? b.namen : [], b.doel) }),
  'POST /api/taak': async (req, q, b) => ({ taak: await nieuweTaak(b) }),
  'POST /api/taak/stop': async (req, q, b) => {
    const t = taken.find(x => x.id === b.id);
    if (!t) throw fout(404, 'Taak niet gevonden');
    t.af = true;
    if (t.status === 'wacht') { t.status = 'gestopt'; t.klaar = Date.now(); }
    return { ok: true };
  },
  'POST /api/map': async (req, q, b) => {
    const f = naamFout(b.naam); if (f) throw fout(400, f);
    const d = await los(b.in || '');
    const doel = path.join(d.abs, b.naam);
    if (await bestaat(doel)) throw fout(409, `"${b.naam}" bestaat al`);
    await fsp.mkdir(doel);
    vergeetGrootte(doel);
    log('Nieuwe map', path.relative(CFG.schijven, doel));
    return { ok: true };
  },
  'POST /api/hernoem': async (req, q, b) => {
    const f = naamFout(b.nieuw); if (f) throw fout(400, f);
    const p = await los(b.pad || '');
    if (p.isRoot) throw fout(400, 'Een schijf kan niet hernoemd worden');
    if (!(await bestaat(p.abs))) throw fout(404, 'Niet gevonden');
    const doel = path.join(path.dirname(p.abs), b.nieuw);
    if (doel === p.abs) return { ok: true };
    if (await bestaat(doel) && b.nieuw.toLowerCase() !== p.naam.toLowerCase()) throw fout(409, `"${b.nieuw}" bestaat al`);
    await fsp.rename(p.abs, doel);
    vergeetGrootte(p.abs); vergeetGrootte(doel);
    await favorietenHernoemd(p.rel, p.rel.split('/').slice(0, -1).concat(b.nieuw).join('/'));
    await mapIconenHernoemd(p.rel, p.rel.split('/').slice(0, -1).concat(b.nieuw).join('/'));
    log('Hernoemd', p.rel, '→', b.nieuw);
    return { ok: true };
  },
  'POST /api/verwijder': async (req, q, b) => {
    if (!Array.isArray(b.paden) || !b.paden.length) throw fout(400, 'Niets gekozen');
    const fouten = [], ids = [];
    let gelukt = 0;
    for (const r of b.paden) {
      try {
        const p = await los(r);
        if (p.isRoot) throw fout(400, 'Een schijf kan niet verwijderd worden');
        if (!(await bestaat(p.abs))) throw fout(404, 'bestaat niet meer');
        ids.push(`${p.schijf}/${await naarPrullenbak(p.abs, p.root)}`);
        gelukt++;
        log('Naar prullenbak', p.rel);
      } catch (e) { fouten.push(`${r}: ${leesbaar(e)}`); }
    }
    return { gelukt, fouten, ids };
  },
  'POST /api/prullenbak/terug': async (req, q, b) => {
    const uit = [], fouten = [];
    for (const id of (b.ids || [])) { try { uit.push(await terugzetten(id)); } catch (e) { fouten.push(leesbaar(e)); } }
    return { teruggezet: uit, fouten };
  },
  'POST /api/prullenbak/weg': async (req, q, b) => {
    let ids = b.ids || [];
    if (b.alles) ids = (await prullenbakLijst()).map(i => i.id);
    const fouten = []; let gelukt = 0;
    for (const id of ids) { try { await definitiefWeg(id); gelukt++; } catch (e) { fouten.push(leesbaar(e)); } }
    log(`Prullenbak: ${gelukt} item(s) definitief verwijderd`);
    return { gelukt, fouten };
  },
};

async function verwerk(req, res) {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const ingelogd = geldigeSessie(koekjes(req).fm_sessie);

  // statische bestanden
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw fout(405, 'Niet toegestaan');
    let naam;
    try { naam = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); } catch { throw fout(404, 'Niet gevonden'); }
    if (naam.includes('..') || naam.includes('/') || naam.includes('\0')) throw fout(404, 'Niet gevonden');
    const abs = path.join(CFG.publiek, naam);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !st.isFile()) throw fout(404, 'Niet gevonden');
    return stuurStatisch(req, res, abs, st, naam);
  }

  const sleutel = `${req.method} ${url.pathname}`;
  if (sleutel === 'POST /api/inloggen') {
    const ip = ipVan(req);
    if (teVaak(req)) throw fout(429, 'Te veel pogingen. Probeer het over 10 minuten opnieuw.');
    const b = await leesJson(req, 10000);
    if (!(gelijk(b.gebruiker || '', CFG.gebruiker) & gelijk(b.wachtwoord || '', CFG.wachtwoord))) {
      noteerFout(req);
      log('Mislukte inlogpoging vanaf', ip);
      await wacht(600);
      throw fout(401, 'Gebruikersnaam of wachtwoord klopt niet');
    }
    pogingen.delete(ip);
    const s = maakSessie();
    const veilig = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `fm_sessie=${s.waarde}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${CFG.sessieDagen * 86400}${veilig}`);
    log('Ingelogd vanaf', ip);
    return stuurJson(res, 200, { ok: true });
  }
  if (sleutel === 'POST /api/uitloggen') {
    res.setHeader('Set-Cookie', 'fm_sessie=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return stuurJson(res, 200, { ok: true });
  }
  if (sleutel === 'GET /api/ik') return stuurJson(res, ingelogd ? 200 : 401, { ingelogd, gebruiker: ingelogd ? CFG.gebruiker : null });

  if (!ingelogd) throw fout(401, 'Niet ingelogd');
  // wijzigingen alleen vanuit de eigen pagina (beschermt tegen CSRF)
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-fm'] !== '1') throw fout(403, 'Verzoek geweigerd');

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url.pathname === '/api/bestand') {
      const p = await los(q.get('pad') || '');
      return stuurBestand(req, res, p.abs, { download: q.get('download') === '1' });
    }
    if (url.pathname === '/api/miniatuur') {
      const p = await los(q.get('pad') || '');
      if (!AFBEELDING.has(ext(p.naam)) && !VIDEO_EXT.has(ext(p.naam))) throw fout(415, 'Geen foto of video');
      const st = await fsp.stat(p.abs).catch(() => null);
      if (!st || !st.isFile()) throw fout(404, 'Niet gevonden');
      let weg = false;
      res.on('close', () => { if (!res.writableFinished) weg = true; });
      const uit = await maakMiniatuur(p.abs, st, q.get('maat') === 'groot' ? 'groot' : 'klein', () => weg);
      return stuurBestand(req, res, uit, { cache: true, naam: p.naam.replace(/\.[^.]+$/, '') + '.jpg' });
    }
    if (url.pathname === '/api/tmdb/poster') return tmdbPoster(req, res, q.get('p'));
    if (url.pathname === '/api/zip') {
      let paden; try { paden = JSON.parse(q.get('paden') || '[]'); } catch { throw fout(400, 'Ongeldig'); }
      return stuurZip(req, res, paden);
    }
  }
  if (sleutel === 'GET /api/zoek') return zoek(req, res, q);
  if (sleutel === 'PUT /api/upload') return stuurJson(res, 200, await upload(req, res, q));

  const route = ROUTES[sleutel];
  if (!route) throw fout(404, 'Onbekend verzoek');
  const body = req.method === 'POST' ? await leesJson(req) : {};
  return stuurJson(res, 200, await route(req, q, body));
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  verwerk(req, res).catch(e => {
    const code = e instanceof Fout ? e.code : 500;
    if (code === 500) log('Fout:', req.method, req.url.split('?')[0], e.stack || e.message);
    if (res.headersSent) return res.destroy();
    stuurJson(res, code, { fout: e instanceof Fout ? e.message : leesbaar(e) });
  });
});
server.requestTimeout = 0;      // grote uploads mogen lang duren
server.headersTimeout = 60000;
server.listen(CFG.poort, async () => {
  log(`Files web draait op poort ${CFG.poort}, schijven in ${CFG.schijven}`);
  for (const n of await schijfNamen()) {
    const abs = path.join(CFG.schijven, n);
    log(`  ${n}: ${(await gekoppeld(n)) ? 'aangekoppeld' : 'NIET aangekoppeld (wordt geblokkeerd)'}, apparaat ${apparaatVan(abs) || '?'}, soort ${schijfSoort(abs) || 'onbekend'}, bestandssysteem ${apparaatVan(abs, true) || '?'}`);
  }
});

function stop() { bewaarGroottesNu(); process.exit(0); }
// een onverwachte fout in een achtergrondtaak mag de app niet laten stoppen: alleen melden
process.on('unhandledRejection', e => log('Onverwachte fout (genegeerd):', e && (e.stack || e.message || e)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
