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
    (el) => dateRe.test(text(el)) && ![...el.children].some((c) => dateRe.test(text(c))),
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

async function check(browser) {
  const context = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();
  const responses = [];
  const pending = [];
  page.on('response', (res) => {
    if (!(res.headers()['content-type'] || '').includes('json')) return;
    pending.push(res.json().then((body) => responses.push({ url: res.url(), body })).catch(() => {}));
  });
  try {
    const args = { dateSrc: dateRegexSource(), statusSrc: STATUS_SRC };
    await page.goto(WATCH_URL, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(2000);
    let cards = await page.evaluate(findCards, args);
    for (let i = 0; i < 3 && cards.length === 0; i++) {
      if (!(await page.evaluate(clickNextMonth))) break;
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);
      cards = await page.evaluate(findCards, args);
    }
    await Promise.all(pending);

    return {
      cards: cards.map((t) => ({ text: t.replace(/\s+/g, ' ').slice(0, 300), status: statusWords(t) })),
      api: jsonHits(responses),
      debug: {
        png: await page.screenshot({ fullPage: true }),
        txt: await page.evaluate(() => document.body.innerText),
        json: JSON.stringify(responses, null, 2).slice(0, 5_000_000),
      },
    };
  } finally {
    await context.close();
  }
}

function writeDebug(d) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(path.join(DEBUG_DIR, 'seite.png'), d.png);
  fs.writeFileSync(path.join(DEBUG_DIR, 'seite.txt'), d.txt);
  fs.writeFileSync(path.join(DEBUG_DIR, 'api.json'), d.json);
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
    const res = await check(browser);
    const words = [...new Set(res.cards.flatMap((c) => c.status))].sort();
    const api = res.api.map(({ url, ...f }) => f);
    const found = res.cards.length > 0 || api.length > 0;
    console.log(`[${now()}] Status: ${words.join(', ') || '–'}${api.length ? ` | API: ${JSON.stringify(api)}` : ''}`);

    next.errors = 0;
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
    console.error(`[${now()}] Fehler: ${e.message}`);
    if (++next.errors === ERROR_ALERT_AFTER) await tell('DPV-Watcher: Seite nicht erreichbar', `${ERROR_ALERT_AFTER} Fehler in Folge: ${e.message}`);
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
