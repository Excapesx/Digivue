#!/usr/bin/env node
/* ============================================================
 * 尼康中国官网：补已有相机 / 镜头参数，不新增名称
 * ------------------------------------------------------------
 * 产品入口来自官网首页和分类页；产品页内 #tech_specs 是完整规格表。
 *
 * 输出 data/specs-nikon.json
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const OUT = join(DATA_DIR, 'specs-nikon.json');
const UA = 'digivue-bot/1.0 (+https://digivue.top)';
const DELAY = 500;

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const LIMIT = Math.max(1, Number(flag('limit', 150)) || 150);
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
  return compact(String(value || '').replace(/^(nikon|尼康)\s*/i, ''));
}

function loadCandidates() {
  const file = join(DATA_DIR, 'candidates.json');
  if (!existsSync(file)) return [];
  const store = JSON.parse(readFileSync(file, 'utf8'));
  return (store.candidates || []).filter((c) =>
    c && (c.brand === '尼康' || /^尼康/.test(c.display || '')));
}

function buildIndex(candidates) {
  const index = new Map();
  for (const c of candidates) {
    const values = new Set([
      c.model,
      String(c.display || '').replace(/^尼康\s*/, ''),
      String(c.brand + ' ' + c.model).replace(/^尼康\s*/, ''),
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

async function discoverProductUrls() {
  const pages = [
    'https://www.nikon.com.cn/',
    'https://www.nikon.com.cn/sc_CN/products/categories/z-series.page?',
    'https://www.nikon.com.cn/sc_CN/products/categories/dslr.page?',
    'https://www.nikon.com.cn/sc_CN/products/categories/coolpix.page?',
    'https://www.nikon.com.cn/sc_CN/products/categories/nikkor-z.page?',
  ];
  const urls = new Set();
  for (const pageUrl of pages) {
    try {
      const res = await fetch(pageUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const html = await res.text();
      for (const m of html.matchAll(/href="([^"]*\/sc_CN\/product\/[^"#?]+)"/g)) {
        const href = m[1].startsWith('http') ? m[1] : 'https://www.nikon.com.cn' + m[1];
        urls.add(href.replace(/\/$/, ''));
      }
    } catch { /* 分类页失败不阻塞其他入口 */ }
  }
  return [...urls];
}

function modelFromTitle(title, h1) {
  const parts = clean(title).split(' - ').map(clean).filter(Boolean);
  if (parts.length >= 2 && /尼康/.test(parts[0])) return parts[1];
  return clean(h1) || parts[parts.length - 1] || '';
}

function specId(url) {
  const raw = new URL(url).pathname;
  const slug = raw.split('/').filter(Boolean).pop()
    .replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return `nikon-${slug || 'model'}-${hash}`;
}

async function main() {
  const candidates = loadCandidates();
  const index = buildIndex(candidates);
  const urls = (await discoverProductUrls()).slice(0, LIMIT);
  console.log(`\n📦 尼康官网：${urls.length} 个产品页；候选池 ${candidates.length} 个尼康型号`);

  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(t)) return route.abort();
    return route.continue();
  });

  const specs = [];
  const skipped = [];
  const errors = [];

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await page.setContent(await res.text(), { waitUntil: 'domcontentloaded' });
      const raw = await page.evaluate(() => {
        const box = document.querySelector('#tech_specs');
        const pairs = box ? [...box.querySelectorAll('.specs_list > li > ul')].map((ul) => {
          const cells = [...ul.querySelectorAll(':scope > li')];
          return {
            label: (cells[0]?.innerText || '').trim(),
            value: (cells[1]?.innerText || '').trim(),
          };
        }) : [];
        return {
          title: document.title || '',
          h1: document.querySelector('h1')?.innerText || '',
          pairs,
        };
      });

      const sections = [];
      const seen = new Set();
      for (const pair of raw.pairs) {
        const label = clean(pair.label);
        const value = clean(pair.value);
        const key = label + '\n' + value;
        if (!label || !value || value.length < 2 || seen.has(key)) continue;
        seen.add(key);
        sections.push({ label, value });
        if (sections.length >= 40) break;
      }
      if (sections.length < 2) {
        skipped.push(`${url}（没有足够参数）`);
        continue;
      }

      const officialModel = modelFromTitle(raw.title, raw.h1);
      const matches = index.get(modelKey(officialModel)) || [];
      if (matches.length !== 1) {
        skipped.push(`${officialModel}（候选池无唯一匹配）`);
        continue;
      }

      const candidate = matches[0];
      specs.push({
        id: specId(url),
        brand: candidate.brand,
        model: candidate.model,
        display: candidate.display,
        category: candidate.category,
        sourceBrand: '尼康',
        officialTitle: officialModel,
        sourceUrl: url,
        fetchedAt: new Date().toISOString(),
        sections,
      });
      console.log(`   ✓ ${officialModel} → ${candidate.display}（${sections.length} 项）`);
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
      console.log(`   ✗ ${url}（${e.message}）`);
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
  console.log(`   未匹配或无参数：${skipped.length} 个产品`);
  if (errors.length) console.log(`   请求失败：${errors.length} 个产品`);

  if (DRY_RUN) {
    console.log('   --dry-run：不写文件');
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'nikon-official',
    count: finalSpecs.length,
    specs: finalSpecs,
  }, null, 2), 'utf8');
  console.log(`\n   输出：${OUT}`);
}

main().catch((err) => {
  console.error('❌ 未预期的错误：', err);
  process.exit(1);
});
