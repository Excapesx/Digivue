#!/usr/bin/env node
/* ============================================================
 * 追加官方参数：只补候选池里已有的型号，不新增名称
 * ------------------------------------------------------------
 * 目前接入小米中国官网：
 *   https://www.mi.com/sitemap.xml 里的 /specs/ 页面
 *
 * 输出 data/specs-official-extra.json，build.mjs 会合并并生成参数页。
 *
 * 用法：
 *   node official-more.mjs --limit 8 --dry-run
 *   node official-more.mjs
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const OUT = join(DATA_DIR, 'specs-official-extra.json');
const UA = 'digivue-bot/1.0 (+https://digivue.top)';
const DELAY = 700;

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const LIMIT = Math.max(1, Number(flag('limit', 500)) || 500);
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

function familyOf(brand, value) {
  if (brand === 'Redmi' || /^(redmi|红米|紅米)/i.test(String(value || ''))) return 'redmi';
  if (brand === '小米' || /^(xiaomi|小米|mi\s|\d)/i.test(String(value || ''))) return 'xiaomi';
  return '';
}

function stripBrand(value) {
  return String(value || '')
    .replace(/^(redmi|xiaomi|红米|紅米|小米|mi)\s*/i, '')
    .trim();
}

function modelKey(value) {
  let s = stripBrand(value).toLowerCase();
  s = s
    .replace(/smartphone|手机|手機/g, ' ')
    .replace(/平板/g, 'pad ')
    .replace(/笔记本/g, 'notebook ')
    .replace(/手环/g, 'band ')
    .replace(/手表/g, 'watch ')
    .replace(/耳机/g, 'earphone ')
    .replace(/移动电源/g, 'powerbank ')
    .replace(/^mi[\s_-]+(?=(note|max|pad|play|mix|a\d|y\d|cc|tv|band|watch))/i, '')
    .replace(/^mi(?=\d)/i, '');
  return compact(s);
}

function titleModel(title) {
  return clean(title)
    .split('|')[0]
    .replace(/\s+参数\s*[-|–].*$/i, '')
    .replace(/\s+参数.*$/i, '')
    .replace(/\s+(specification|specifications).*$/i, '')
    .replace(/\s+[-–—]\s+.*$/g, '')
    .replace(/^Especificaciones\s+/i, '')
    .replace(/参数$/g, '')
    .trim();
}

function loadCandidates() {
  const ids = new Set(['phone', 'tablet', 'laptop', 'desktop', 'wearable', 'camera', 'lens', 'peripheral', 'accessory']);
  const merged = new Map();
  for (const name of ['candidates.json', 'candidates-brands.json']) {
    const file = join(DATA_DIR, name);
    if (!existsSync(file)) continue;
    const store = JSON.parse(readFileSync(file, 'utf8'));
    for (const c of store.candidates || []) {
      if (!c.display || !ids.has(c.category)) continue;
      const key = compact(c.brand + '|' + c.model);
      if (!merged.has(key)) merged.set(key, { ...c, key });
    }
  }
  return [...merged.values()];
}

function buildMatchIndex(candidates) {
  const index = new Map();
  for (const c of candidates) {
    const family = familyOf(c.brand, c.display);
    if (!family) continue;
    /* 只从完整展示名提取型号。不能单独使用 model 字段：
       Wikidata 里有些品牌会被拆成「紅米Note」+ 数字，单独取数字会把
       Redmi 5A 错配成 Redmi Note 5A。 */
    const values = new Set([
      stripBrand(c.display),
      stripBrand(c.brand + ' ' + c.model),
    ]);
    for (const value of values) {
      const mk = modelKey(value);
      if (!mk) continue;
      const key = family + '|' + mk;
      const list = index.get(key) || [];
      if (!list.some((x) => x.key === c.key)) list.push(c);
      index.set(key, list);
    }
  }
  return index;
}

function matchCandidate(index, officialModel) {
  const family = familyOf('', officialModel);
  if (!family) return null;
  const mk = modelKey(officialModel);
  if (!mk) return null;
  const list = index.get(family + '|' + mk) || [];
  return list.length === 1 ? list[0] : null;
}

function specScore(spec) {
  const family = familyOf(spec.brand, spec.display);
  const mk = modelKey(spec.model);
  const parts = new URL(spec.sourceUrl).pathname.split('/').filter(Boolean);
  const slug = compact(parts[parts.length - 2] || '');
  const expected = new Set([
    compact(family + mk),
    compact('xiaomi' + mk),
    compact('mi' + mk),
    mk,
  ]);
  if (family === 'redmi') expected.add(compact('hongmi' + mk));
  return (expected.has(slug) ? 1000 : 0) + spec.sections.length;
}

async function discoverSpecUrls() {
  const res = await fetch('https://www.mi.com/sitemap.xml', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`小米 sitemap HTTP ${res.status}`);
  const xml = await res.text();
  return [...new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].trim())
    .filter((u) => /\/specs\/$/.test(u)))];
}

async function main() {
  const candidates = loadCandidates();
  const matchIndex = buildMatchIndex(candidates);
  const urls = (await discoverSpecUrls()).slice(0, LIMIT);
  console.log(`\n📦 小米官网：${urls.length} 个规格页；候选池 ${candidates.length} 个型号`);

  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(t)) return route.abort();
    return route.continue();
  });

  const specs = [];
  const errors = [];

  for (const url of urls) {
    let html;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
      console.log(`   ✗ ${url}（${e.message}）`);
      await sleep(DELAY);
      continue;
    }

    try {
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      const raw = await page.evaluate(() => {
        const sections = [...document.querySelectorAll('.section')].map((section) => ({
          label: (section.querySelector('.tit')?.innerText || '').trim(),
          value: (section.querySelector('.context')?.innerText || '').trim(),
        })).filter((x) => x.label && x.value);

        const rows = [...document.querySelectorAll('table tr')].map((tr) => {
          const cells = [...tr.querySelectorAll('th,td')].map((x) => (x.innerText || '').trim()).filter(Boolean);
          return cells.length >= 2 ? { label: cells[0], value: cells.slice(1).join(' / ') } : null;
        }).filter(Boolean);

        return { title: document.title || '', sections: [...sections, ...rows] };
      });

      const officialModel = titleModel(raw.title);
      const candidate = matchCandidate(matchIndex, officialModel);
      if (!candidate) {
        console.log(`   · ${officialModel}（候选池无唯一匹配，跳过）`);
        await sleep(DELAY);
        continue;
      }

      const seen = new Set();
      const sections = raw.sections.map((x) => ({
        label: clean(x.label).replace(/\s+/g, ' '),
        value: clean(x.value),
      })).filter((x) => {
        const key = x.label + '\n' + x.value;
        if (!x.label || !x.value || x.value.length < 2 || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 30);

      if (sections.length < 2) {
        console.log(`   · ${officialModel}（没有足够参数，跳过）`);
        await sleep(DELAY);
        continue;
      }

      const path = new URL(url).pathname.split('/').filter(Boolean);
      const slug = path[path.length - 2] || 'spec';
      specs.push({
        id: `xiaomi-${slug}`,
        brand: candidate.brand,
        model: candidate.model,
        display: candidate.display,
        category: candidate.category,
        sourceBrand: '小米',
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

  /* 同一型号有多个地区页面时，保留参数最多的一份。 */
  const best = new Map();
  for (const s of specs) {
    const key = compact(s.brand + '|' + s.model);
    const prev = best.get(key);
    if (!prev || specScore(s) > specScore(prev)) best.set(key, s);
  }
  const finalSpecs = [...best.values()].sort((a, b) =>
    a.category.localeCompare(b.category) || a.display.localeCompare(b.display, 'zh'));

  console.log(`\n✅ 已匹配并解析：${finalSpecs.length} 个已有型号`);
  console.log(`   未匹配或无参数：${urls.length - finalSpecs.length} 个页面`);
  if (errors.length) console.log(`   请求失败：${errors.length} 个页面`);

  if (DRY_RUN) {
    console.log('   --dry-run：不写文件');
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'xiaomi-official',
    count: finalSpecs.length,
    specs: finalSpecs,
  }, null, 2), 'utf8');
  console.log(`\n   输出：${OUT}`);
}

main().catch((err) => {
  console.error('❌ 未预期的错误：', err);
  process.exit(1);
});
