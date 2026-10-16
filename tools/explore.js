#!/usr/bin/env node
// Öffnet mehrere Portal-Seiten ohne Login und hält fest, was ein Besucher sieht:
// Endadresse, Titel, Text, Links, Daten-Antworten und einen Screenshot.
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'https://portal.dpv-padel.de';
const VENUE = 'd5526bf5-086f-48a9-b2b1-3d734db7c1bd';
const PATHS = (process.env.PATHS || [
  '/', '/clubs', '/vereine', '/venues', '/tournaments', '/turniere', '/events',
  `/venues/${VENUE}`, `/venues/${VENUE}?tab=calendar`,
].join(',')).split(',');
const OUT = path.join(process.env.OUT || 'debug', 'explore');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch(process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {});
  const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
  const summary = [];
  for (const [i, p] of PATHS.entries()) {
    const url = p.startsWith('http') ? p : BASE + p;
    const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin', userAgent });
    const page = await ctx.newPage();
    const api = [];
    const pending = [];
    page.on('response', (res) => {
      const u = res.url();
      if (!u.startsWith(BASE) || !(res.headers()['content-type'] || '').includes('json')) return;
      pending.push(res.text().then((t) => api.push({ status: res.status(), url: u.slice(0, 200), body: t.slice(0, 800) })).catch(() => {}));
    });
    const rec = { requested: url };
    try {
      const nav = await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
      await page.waitForTimeout(2500);
      await Promise.all(pending);
      rec.status = nav?.status();
      rec.finalUrl = page.url();
      rec.title = await page.title();
      rec.text = (await page.evaluate(() => document.body.innerText)).slice(0, 3000);
      rec.links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].slice(0, 80)
        .map((a) => `${(a.innerText || '').trim().slice(0, 50)} -> ${a.getAttribute('href')}`));
      rec.api = api;
      await page.screenshot({ path: path.join(OUT, `${String(i).padStart(2, '0')}.png`) });
    } catch (e) {
      rec.error = e.message.slice(0, 300);
    }
    fs.writeFileSync(path.join(OUT, `${String(i).padStart(2, '0')}.json`), JSON.stringify(rec, null, 2));
    const login = /passwort|willkommen zur(ü|ue)ck/i.test(rec.text || '');
    summary.push(`${String(i).padStart(2, '0')} ${rec.status ?? 'ERR'} ${login ? 'LOGIN ' : 'INHALT'} ${url}  ->  ${rec.finalUrl ?? rec.error}`);
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, 'uebersicht.txt'), summary.join('\n') + '\n');
  console.log(summary.join('\n'));
  await browser.close();
})();
