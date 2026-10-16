#!/usr/bin/env node
// Watcher: meldet sich, sobald das Turnier am 06.11. auf portal.dpv-padel.de
// seinen Status ändert (z. B. von "Veröffentlicht" auf "Anmelden").
// Läuft entweder als Dauerschleife (node watch.js) oder einmalig pro Aufruf
// (node watch.js --once, z. B. aus GitHub Actions).
'use strict';

const { chromium } = require('playwright');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const WATCH_URL = process.env.WATCH_URL ||
  'https://portal.dpv-padel.de/venues/d5526bf5-086f-48a9-b2b1-3d734db7c1bd?tab=calendar';
const TARGET_DATE = process.env.TARGET_DATE || '2026-11-06'; // YYYY-MM-DD
const INTERVAL_MIN = Number(process.env.INTERVAL_MIN || 5);
const NTFY_TOPIC = process.env.NTFY_TOPIC || ''; // Push aufs Handy via ntfy.sh
const FAIL_ON_CHANGE = process.env.FAIL_ON_CHANGE === '1'; // --once: Exit 10 bei Meldung (GitHub mailt dann)
const ERROR_ALERT_AFTER = 6; // so viele Fehlversuche in Folge -> Warnung
const ONCE = process.argv.includes('--once');
const DEBUG = process.argv.includes('--debug') || process.env.DEBUG === '1';
const DPV_EMAIL = process.env.DPV_EMAIL || '';
const DPV_PASSWORD = process.env.DPV_PASSWORD || '';
const SESSION_FILE = process.env.SESSION_FILE || path.join(__dirname, 'session.json');
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const DEBUG_DIR = path.join(__dirname, 'debug');

const [Y, M, D] = TARGET_DATE.split('-').map(Number);

// Statuswörter, die auf einer Turnierkarte stehen können
const STATUS_SRC =
  'ver(?:ö|oe)ffentlicht|jetzt anmelden|anmelden|anmeldung(?:\\s+(?:offen|ge(?:ö|oe)ffnet|m(?:ö|oe)glich|geschlossen))?' +
  '|registrierung(?:\\s+offen)?|ausgebucht|warteliste|geschlossen|abgesagt|laufend|beendet';

function dateRegexSource() {
  const d = D < 10 ? `0?${D}` : `${D}`;
  const m = M < 10 ? `0?${M}` : `${M}`;
  const months = ['jan', 'feb', 'm(?:ä|ae)r', 'apr', 'ma[iy]', 'jun', 'jul', 'aug', 'sep', 'o[kc]t', 'nov', 'de[zc]'];
  const mon = `${months[M - 1]}[a-zä]*\\.?`;
  return [
    `(?<!\\d)${d}\\.\\s?${m}(?!\\d)`,      // 06.11. / 6.11.2026
    `(?<!\\d)${d}\\.?\\s*${mon}`,          // 6. Nov / 06. November
    `${mon}\\s*${d}(?!\\d)`,               // Nov 6
    TARGET_DATE,                            // 2026-11-06
  ].join('|');
}

// Läuft im Browser: sucht die kleinsten Elemente mit dem Datum und dazu die
// kleinste umgebende "Karte", in der ein Statuswort steht.
function findCards({ dateSrc, statusSrc }) {
  const dateRe = new RegExp(dateSrc, 'i');
  const statusRe = new RegExp(statusSrc, 'i');
  const text = (el) => (el.innerText || '').trim();
  const leaves = [...document.body.querySelectorAll('*')].filter(
    (el) => !el.closest('script, style, noscript, template') &&
      dateRe.test(text(el)) && ![...el.children].some((c) => dateRe.test(text(c))),
  );
  const cards = new Map();
  for (const leaf of leaves) {
    let el = leaf;
    while (el && el !== document.body && !statusRe.test(text(el)) && text(el).length < 2000) {
      el = el.parentElement;
    }
    const t = el && el !== document.body && text(el).length < 2000 ? text(el) : text(leaf);
    cards.set(t, true);
  }
  return [...cards.keys()];
}

// Läuft im Browser: klickt "nächster Monat", falls der Kalender noch Oktober zeigt.
function clickNextMonth() {
  const nextRe = /next|n(ä|ae)chste|weiter|vorw(ä|ae)rts/i;
  const arrows = ['›', '>', '→', '»', '❯', '⟩'];
  const el = [...document.querySelectorAll('button, a, [role=button]')].find((b) => {
    const label = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''}`;
    return nextRe.test(label) || arrows.includes((b.textContent || '').trim());
  });
  if (!el) return false;
  el.click();
  return true;
}

function statusWords(cardText) {
  const words = new Set();
  for (const m of cardText.matchAll(new RegExp(STATUS_SRC, 'gi'))) {
    const w = m[0].toLowerCase();
    words.add(w.charAt(0).toUpperCase() + w.slice(1));
  }
  return [...words].sort();
}

function isOpen(words) {
  return words.some((w) => /anmelden|anmeldung (offen|ge(ö|oe)ffnet|m(ö|oe)glich)|registrierung offen/i.test(w));
}

// Durchsucht abgefangene JSON-Antworten nach Objekten mit Datum am Zieltag
// und merkt sich deren Status-Felder.
function jsonHits(responses) {
  const hits = [];
  const onTarget = (v) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return false;
    if (v.length === 10) return v === TARGET_DATE;
    const t = new Date(v);
    return !isNaN(t) && t.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }) === TARGET_DATE;
  };
  const walk = (o, url) => {
    if (Array.isArray(o)) return o.forEach((x) => walk(x, url));
    if (!o || typeof o !== 'object') return;
    if (Object.values(o).some(onTarget)) {
      const pick = {};
      for (const [k, v] of Object.entries(o)) {
        if (v !== null && typeof v === 'object') continue;
        if (/status|state|registr|anmeld|phase|open|publish|name|title|bezeichnung/i.test(k)) pick[k] = v;
      }
      hits.push({ url: url.split('?')[0], ...pick });
    }
    Object.values(o).forEach((x) => walk(x, url));
  };
  responses.forEach((r) => walk(r.body, r.url));
  return hits;
}

// --- Login (Testkonto aus den Secrets DPV_EMAIL / DPV_PASSWORD) -------------------------------------------------

// Antworten dieser Adressen werden nie gespeichert (enthalten Sitzungs-Tokens oder Profildaten)
const SECRET_URL = /authenticate|\/auth\b|auth\/|token|login|logout|password|session|profile|\/me(\?|\/|$)/i;

// Entfernt Zugangsdaten, Tokens und E-Mail-Adressen aus Text, der veröffentlicht werden könnte
function scrub(text) {
  let out = String(text);
  for (const secret of [DPV_EMAIL, DPV_PASSWORD]) if (secret.length >= 6) out = out.split(secret).join('***');
  return out
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '***jwt***')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***@***');
}

class LoginError extends Error {}

// Das Portal fragt dauerhaft nach (z. B. /api/pulse), "networkidle" wird oft nie erreicht: nur begrenzt warten
async function settle(page, ms = 8000) {
  await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  await page.waitForTimeout(2000);
}

const onLoginPage = (page) => page.locator('input[type=password]').first().isVisible({ timeout: 3000 }).catch(() => false);

async function dismissCookies(page) {
  const btn = page.getByRole('button', { name: /^ablehnen$/i }).first();
  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) await btn.click().catch(() => {});
}

async function login(page) {
  await dismissCookies(page);
  await page.getByLabel(/e-?mail/i).first().fill(DPV_EMAIL, { timeout: 10_000 });
  await page.locator('input[type=password]').first().fill(DPV_PASSWORD, { timeout: 10_000 });
  await page.getByRole('button', { name: /^anmelden$/i }).first().click({ timeout: 10_000 });
  await settle(page, 15_000);
  await page.waitForTimeout(2500);
}

// Abbild des aktuellen Zustands für die Diagnose. Eingeloggt: kein HTML, nur der Hauptbereich als Bild.
function tournamentsFrom(responses) {
  const out = [];
  for (const r of responses) {
    for (const s of r.body?.series || []) {
      for (const t of s.tournamentSummaries || []) {
        out.push({ id: t.id, name: t.name, serie: s.name, state: t.currentState, start: t.startDate,
          registrationStart: t.registrationStart || s.registrationStart, registrationEnd: t.registrationEnd || s.registrationEnd,
          plaetze: t.capacities ? `${t.capacities.used}/${t.capacities.max}` : undefined });
      }
    }
  }
  return out.sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

async function snapshot(page, responses, info) {
  await page.evaluate(() => document.querySelectorAll('input').forEach((i) => { i.value = ''; })).catch(() => {});
  let png = null;
  if (info.loggedIn) {
    const main = page.locator('main, [role=main]').first();
    if (await main.count().catch(() => 0)) png = await main.screenshot({ timeout: 5000 }).catch(() => null);
  } else {
    png = await page.screenshot({ fullPage: true }).catch(() => null);
  }
  const apiDump = responses.map((r) => ({ url: r.url, body: JSON.stringify(r.body).slice(0, 20_000) }));
  return {
    png,
    txt: scrub(await page.evaluate(() => document.body.innerText).catch(() => '')),
    json: scrub(JSON.stringify(apiDump, null, 2).slice(0, 2_000_000)),
    html: info.loggedIn ? '' : scrub((await page.content().catch(() => '')).slice(0, 500_000)),
    info: scrub(JSON.stringify(info, null, 2)),
    turniere: scrub(JSON.stringify(tournamentsFrom(responses), null, 2)),
  };
}

async function check(browser, state) {
  // Headless-Chrome meldet sich sonst als "HeadlessChrome"; hier die normale Kennung desselben Browsers
  const userAgent = process.env.USER_AGENT ||
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
  const useSession = !!DPV_EMAIL && fs.existsSync(SESSION_FILE);
  const context = await browser.newContext({
    locale: 'de-DE', timezoneId: 'Europe/Berlin', userAgent,
    ...(useSession ? { storageState: SESSION_FILE } : {}),
  });
  const page = await context.newPage();
  const responses = [];
  const pending = [];
  const info = { userAgent, navStatus: null, finalUrl: null, title: null, loggedIn: false, login: useSession ? 'Sitzung wiederverwendet' : 'nicht nötig', console: [], failed: [], requests: [] };
  page.on('console', (m) => { if (m.type() === 'error' && info.console.length < 30) info.console.push(m.text().slice(0, 300)); });
  page.on('requestfailed', (r) => { if (info.failed.length < 30) info.failed.push(`${r.url().slice(0, 200)} ${r.failure()?.errorText}`); });
  page.on('response', (res) => {
    if (info.requests.length < 150) info.requests.push(`${res.status()} ${res.request().resourceType()} ${res.url().slice(0, 200)}`);
    if (SECRET_URL.test(res.url())) return;
    if (!(res.headers()['content-type'] || '').includes('json')) return;
    pending.push(res.json().then((body) => responses.push({ url: res.url(), body })).catch(() => {}));
  });
  try {
    const args = { dateSrc: dateRegexSource(), statusSrc: STATUS_SRC };
    const nav = await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    info.navStatus = nav?.status() ?? null;
    await settle(page);

    if (await onLoginPage(page)) {
      if (!DPV_EMAIL || !DPV_PASSWORD) throw new LoginError('Das Portal verlangt einen Login, aber DPV_EMAIL/DPV_PASSWORD sind nicht gesetzt');
      if (state?.loginRetryAt > Date.now() && process.env.FORCE_LOGIN !== '1') {
        const e = new Error(`Login pausiert bis ${new Date(state.loginRetryAt).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })}`);
        e.paused = true;
        throw e;
      }
      info.login = 'durchgeführt';
      await login(page);
      await page.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await settle(page);
      if (await onLoginPage(page)) {
        const e = new LoginError('Login fehlgeschlagen (Zugangsdaten falsch, reCAPTCHA oder Sperre?)');
        info.login = 'fehlgeschlagen';
        throw e;
      }
    }
    info.loggedIn = !!DPV_EMAIL && !(await onLoginPage(page));
    if (info.loggedIn) await context.storageState({ path: SESSION_FILE });

    let cards = await page.evaluate(findCards, args);
    for (let i = 0; i < 3 && cards.length === 0; i++) {
      if (!(await page.evaluate(clickNextMonth))) break;
      await settle(page, 5000);
      cards = await page.evaluate(findCards, args);
    }
    await Promise.all(pending);
    info.finalUrl = page.url();
    info.title = await page.title();

    return {
      cards: cards.map((t) => ({ text: scrub(t.replace(/\s+/g, ' ').slice(0, 300)), status: statusWords(t) })),
      api: jsonHits(responses),
      debug: await snapshot(page, responses, info),
    };
  } catch (e) {
    await Promise.all(pending).catch(() => {});
    e.debug = await snapshot(page, responses, info).catch(() => null);
    throw e;
  } finally {
    await context.close();
  }
}

function writeDebug(d) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  if (d.png) fs.writeFileSync(path.join(DEBUG_DIR, 'seite.png'), d.png);
  fs.writeFileSync(path.join(DEBUG_DIR, 'seite.txt'), d.txt);
  fs.writeFileSync(path.join(DEBUG_DIR, 'api.json'), d.json);
  if (d.html) fs.writeFileSync(path.join(DEBUG_DIR, 'seite.html'), d.html);
  fs.writeFileSync(path.join(DEBUG_DIR, 'info.json'), d.info);
  if (d.turniere) fs.writeFileSync(path.join(DEBUG_DIR, 'turniere.json'), d.turniere);
}

async function notify(title, msg) {
  console.log(`\x07\n🔔 ${title}\n${msg}\n`);
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)} sound name "Glass"`], () => {});
  } else if (process.platform === 'linux' && !process.env.CI) {
    execFile('notify-send', ['-u', 'critical', title, msg], () => {});
  }
  if (NTFY_TOPIC) {
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: 'POST',
      body: `${msg}\n${WATCH_URL}`,
      headers: { Title: title, Priority: 'urgent', Tags: 'tennis', Click: WATCH_URL },
    }).catch((e) => console.error('ntfy fehlgeschlagen:', e.message));
  }
}

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const now = () => new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
const launch = () => chromium.launch(process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {});

// Ein Durchlauf. state = { found, status, api, misses, errors } | null. Gibt true zurück, wenn gemeldet wurde.
async function runOnce(browser, state) {
  let notified = false;
  const tell = async (...a) => { notified = true; await notify(...a); };
  const next = { found: false, status: [], api: [], misses: 0, errors: 0, ...state };
  try {
    const res = await check(browser, state);
    const words = [...new Set(res.cards.flatMap((c) => c.status))].sort();
    const api = res.api.map(({ url, ...f }) => f);
    const found = res.cards.length > 0 || api.length > 0;
    console.log(`[${now()}] Status: ${words.join(', ') || '–'}${api.length ? ` | API: ${JSON.stringify(api)}` : ''}`);

    next.errors = 0;
    next.loginFailures = 0;
    next.loginRetryAt = 0;
    if (!state || DEBUG || !found) writeDebug(res.debug);
    if (!state) {
      res.cards.forEach((c) => console.log(`   Karte: ${c.text}`));
      res.api.forEach((h) => console.log(`   API-Treffer (${h.url})`));
    }

    if (!found) {
      console.log(`   ⚠️  Turnier am ${D}.${M}. nicht gefunden – siehe ${DEBUG_DIR}/`);
      if (++next.misses === 3) await tell('DPV-Watcher: Turnier nicht gefunden', `Seit 3 Checks kein Turnier am ${D}.${M}. sichtbar.`);
    } else {
      const seen = state && state.found ? state : null;
      const changed = seen && JSON.stringify([seen.status, seen.api]) !== JSON.stringify([words, api]);
      if (isOpen(words) && (!seen || changed)) {
        await tell('DPV Padel: Anmeldung offen!', `Turnier am ${D}.${M}.: ${words.join(', ')}`);
      } else if (changed) {
        await tell('DPV Padel: Status geaendert', `Turnier am ${D}.${M}.: ${seen.status.join(', ') || '–'} -> ${words.join(', ') || '–'}`);
      }
      Object.assign(next, { found: true, status: words, api, misses: 0 });
    }
  } catch (e) {
    console.error(`[${now()}] Fehler: ${scrub(e.message)}`);
    if (e.debug) writeDebug(e.debug);
    if (e instanceof LoginError && DPV_EMAIL && DPV_PASSWORD) {
      // Nicht alle 5 Minuten neu versuchen, sonst sperrt das Portal evtl. das Konto
      next.loginFailures = (next.loginFailures || 0) + 1;
      const hours = Math.min(next.loginFailures, 6);
      next.loginRetryAt = Date.now() + hours * 3_600_000;
      await tell('DPV-Watcher: Login fehlgeschlagen', `${scrub(e.message)}. Nächster Versuch in ${hours} h.`);
    }
    if (++next.errors === ERROR_ALERT_AFTER) await tell('DPV-Watcher: Seite nicht erreichbar', `${ERROR_ALERT_AFTER} Fehler in Folge: ${scrub(e.message)}`);
  }
  saveState(next);
  return { notified, next };
}

async function main() {
  console.log(`Beobachte ${WATCH_URL}\nTurnier am ${D}.${M}.${Y}${ONCE ? ' (einmaliger Check)' : `, alle ${INTERVAL_MIN} min`}${NTFY_TOPIC ? ', Push an ntfy.sh' : ''}\n`);
  let browser;
  let state = loadState();
  let code = 0;
  for (;;) {
    try {
      browser = browser || await launch();
      const r = await runOnce(browser, state);
      state = r.next;
      if (r.notified && FAIL_ON_CHANGE) code = 10;
      if (state.errors) { await browser.close().catch(() => {}); browser = null; } // nach Fehler frischer Browser
    } catch (e) { // Browser-Start fehlgeschlagen o. Ä.
      console.error(`[${now()}] Fehler: ${e.message}`);
      await browser?.close().catch(() => {});
      browser = null;
      if (ONCE) code = 1;
    }
    if (ONCE) break;
    const jitter = (Math.random() - 0.5) * 30_000;
    await new Promise((r) => setTimeout(r, Math.max(30_000, INTERVAL_MIN * 60_000 + jitter)));
  }
  await browser?.close().catch(() => {});
  process.exit(code);
}

main();
