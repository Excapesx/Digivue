#!/usr/bin/env node
/* ============================================================
 * 佳能中国官网：补已有型号参数，不新增名称
 * ------------------------------------------------------------
 * 型号入口来自 /overview/eos.html 和 /overview/cinemaeos.html，
 * 规格页是 /product/{slug}/spec.html 里的表格。
 *
 * 输出 data/specs-canon.json
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const OUT = join(DATA_DIR, 'specs-canon.json');
const UA = 'digivue-bot/1.0 (+https://digivue.top)';
const DELAY = 600;

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const LIMIT = Math.max(1, Number(flag('limit', 100)) || 100);
const DRY_RUN = Boolean(flag('dry-run', false));

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
    'C:/Users/Administrator/AppData/Local/Temp/pwshot/node_modules/playwright',
  ].filter(Boolean);
  for (const p of candidates) {
    try { return require(p); } catch { /* 试下一个 */ }
  }
  throw new Error('找不到 playwright，请在 .env 里设置 PLAYWRIGHT_PATH');
}
const { chromium } = loadPlaywright();
const EXE = process.env.CHROME_PATH || 'C:/Program Files/Edge/App/116.0.1938.76/msedge.exe';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const compact = (s) => String(s || '').toLowerCase()
  .replace(/[（）()【】\[\]]/g, ' ')
  .replace(/[^a-z0-9\u4e00-\u9fa5+]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function modelKey(value) {
  return compact(String(value || '').replace(/^(canon|佳能)\s*/i, ''));
}

function loadCandidates() {
  const file = join(DATA_DIR, 'candidates.json');
  if (!existsSync(file)) return [];
  const store = JSON.parse(readFileSync(file, 'utf8'));
  return (store.candidates || []).filter((c) =>
    c && (c.brand === '佳能' || /^佳能/.test(c.display || '')));
}

function buildIndex(candidates) {
  const index = new Map();
  for (const c of candidates) {
    const values = new Set([
      c.model,
      String(c.display || '').replace(/^佳能\s*/, ''),
      String(c.brand + ' ' + c.model).replace(/^佳能\s*/, ''),
    ]);
    for (const value of values) {
      const key = modelKey(value);
      if (!key) continue;
      const list = index.get(key) || [];
      if (!list.some((x) => x.key === c.key)) list.push(c);
      index.set(key, list);
    }
  }
  return index;
}

function modelFromTitle(title) {
  const parts = clean(title).split(' - ').map(clean).filter(Boolean);
  const i = parts.indexOf('规格/配件');
  if (i >= 0 && parts[i + 1]) return parts[i + 1];
  return parts.length >= 3 ? parts[2] : parts[0] || '';
}

async function main() {
  const candidates = loadCandidates();
  const index = buildIndex(candidates);
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(t)) return route.abort();
    return route.continue();
  });

  const productUrls = new Set();
  for (const overview of ['https://www.canon.com.cn/overview/eos.html', 'https://www.canon.com.cn/overview/cinemaeos.html']) {
    try {
      await page.goto(overview, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);
      const links = await page.evaluate(() =>
        [...new Set([...document.querySelectorAll('a')].map((a) => a.href))]
          .filter((h) => /^https:\/\/www\.canon\.com\.cn\/product\/[^/]+\/$/.test(h)));
      links.forEach((u) => productUrls.add(u));
    } catch (e) {
      console.log(`   ✗ ${overview}（${e.message}）`);
    }
  }

  const urls = [...productUrls].slice(0, LIMIT);
  console.log(`\n📦 佳能官网：${urls.length} 个相机型号；候选池 ${candidates.length} 个佳能型号`);

  const specs = [];
  const skipped = [];
  const errors = [];

  for (const productUrl of urls) {
    const specUrl = new URL('spec.html', productUrl).href;
    try {
      const res = await fetch(specUrl, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await page.setContent(await res.text(), { waitUntil: 'domcontentloaded' });
      const raw = await page.evaluate(() => {
        const rows = [];
        for (const table of document.querySelectorAll('table')) {
          let head = '';
          let prev = table.previousElementSibling;
          for (let i = 0; i < 5 && prev; i++, prev = prev.previousElementSibling) {
            if (/^H[2-4]$/.test(prev.tagName) && prev.innerText.trim()) {
              head = prev.innerText.trim();
              break;
            }
          }
          for (const tr of table.querySelectorAll('tr')) {
            const cells = [...tr.querySelectorAll('th,td')]
              .map((x) => (x.innerText || '').trim())
              .filter(Boolean);
            if (cells.length >= 2) {
              rows.push({
                label: head && head !== cells[0] ? `${head} - ${cells[0]}` : cells[0],
                value: cells.slice(1).join(' / '),
              });
            }
          }
        }
        return { title: document.title || '', rows };
      });

      const sections = [];
      const seen = new Set();
      for (const row of raw.rows) {
        const label = clean(row.label);
        const value = clean(row.value);
        const key = label + '\n' + value;
        if (!label || !value || value.length < 2 || seen.has(key)) continue;
        seen.add(key);
        sections.push({ label, value });
        if (sections.length >= 30) break;
      }

      if (sections.length < 2) {
        skipped.push(`${productUrl}（没有足够参数）`);
        continue;
      }

      const officialModel = modelFromTitle(raw.title);
      const matches = index.get(modelKey(officialModel)) || [];
      if (matches.length !== 1) {
        skipped.push(`${officialModel}（候选池无唯一匹配）`);
        continue;
      }

      const candidate = matches[0];
      const slug = new URL(productUrl).pathname.split('/').filter(Boolean).pop();
      specs.push({
        id: `canon-${slug}`,
        brand: candidate.brand,
        model: candidate.model,
        display: candidate.display,
        category: candidate.category,
        sourceBrand: '佳能',
        officialTitle: officialModel,
        sourceUrl: specUrl,
        fetchedAt: new Date().toISOString(),
        sections,
      });
      console.log(`   ✓ ${officialModel} → ${candidate.display}（${sections.length} 项）`);
    } catch (e) {
      errors.push(`${specUrl} → ${e.message}`);
      console.log(`   ✗ ${specUrl}（${e.message}）`);
    }
    await sleep(DELAY);
  }

  await browser.close();

  const best = new Map();
  for (const s of specs) {
    const key = compact(s.brand + '|' + s.model);
    const prev = best.get(key);
    if (!prev || s.sections.length > prev.sections.length) best.set(key, s);
  }
  const finalSpecs = [...best.values()].sort((a, b) => a.display.localeCompare(b.display, 'zh'));

  console.log(`\n✅ 已匹配并解析：${finalSpecs.length} 个已有型号`);
  console.log(`   未匹配或无参数：${skipped.length} 个型号`);
  if (errors.length) console.log(`   请求失败：${errors.length} 个型号`);

  if (DRY_RUN) {
    console.log('   --dry-run：不写文件');
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'canon-official',
    count: finalSpecs.length,
    specs: finalSpecs,
  }, null, 2), 'utf8');
  console.log(`\n   输出：${OUT}`);
}

main().catch((err) => {
  console.error('❌ 未预期的错误：', err);
  process.exit(1);
});
