#!/usr/bin/env node
/* ============================================================
 * 三星中国官网：补已有型号参数，不新增名称
 * ------------------------------------------------------------
 * sitemap 里的手机 URL 是按颜色/容量拆开的 SKU。先按型号代码
 * 归并成家族，再调用官网公开的商品规格接口，避免重复抓取。
 *
 * 输出 data/specs-samsung.json
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const OUT = join(DATA_DIR, 'specs-samsung.json');
const UA = 'digivue-bot/1.0 (+https://digivue.top)';
const DELAY = 350;

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const LIMIT = Math.max(1, Number(flag('limit', 200)) || 200);
const DRY_RUN = Boolean(flag('dry-run', false));

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const compact = (s) => String(s || '').toLowerCase()
  .replace(/[（）()【】\[\]]/g, ' ')
  .replace(/[^a-z0-9\u4e00-\u9fa5+]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function modelKey(value) {
  return compact(String(value || '').replace(/^(samsung|三星)\s*/i, ''));
}

function loadCandidates() {
  const file = join(DATA_DIR, 'candidates.json');
  if (!existsSync(file)) return [];
  const store = JSON.parse(readFileSync(file, 'utf8'));
  return (store.candidates || []).filter((c) =>
    c && c.category === 'phone' && (c.brand === '三星' || /^三星/.test(c.display || '')));
}

function buildIndex(candidates) {
  const index = new Map();
  for (const c of candidates) {
    const values = new Set([
      c.model,
      String(c.display || '').replace(/^三星\s*/, ''),
      String(c.brand + ' ' + c.model).replace(/^三星\s*/, ''),
    ]);
    for (const v of values) {
      const key = modelKey(v);
      if (!key) continue;
      const list = index.get(key) || [];
      if (!list.some((x) => x.key === c.key)) list.push(c);
      index.set(key, list);
    }
  }
  return index;
}

const COLOR_WORDS = new Set([
  'awesome', 'phantom', 'bora', 'sky', 'pink', 'burgundy', 'graphite', 'green',
  'violet', 'cream', 'black', 'white', 'blue', 'peach', 'lime', 'lemon',
  'lilac', 'mint', 'purple', 'orange', 'red', 'navy', 'gray', 'grey',
  'icyblue', 'titanium', 'silver', 'yellow', 'crafted', 'olive', 'lightgray',
  'carbon', 'cobalt', 'coral', 'lavender', 'beige', 'teal', 'rose', 'gold',
  'sierra', 'jade', 'burgundy', 'pinkgold',
]);

function cleanSlugModel(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  let slug = parts[parts.length - 1] || '';
  slug = slug.replace(/-sm-[a-z0-9]+$/i, '');
  const tokens = slug.split('-').filter(Boolean);
  const stop = tokens.findIndex((t) =>
    /^(?:\d+gb|1tb|2tb|4tb)$/i.test(t) || COLOR_WORDS.has(t.toLowerCase()));
  if (stop > 0) slug = tokens.slice(0, stop).join('-');
  return slug.replace(/-/g, ' ');
}

function familyKey(url) {
  const code = String(url).match(/-sm-([a-z]\d+)[a-z0-9]*\/?$/i);
  if (code) return code[1].toLowerCase();
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return parts[parts.length - 1].toLowerCase();
}

function fullModelCode(url) {
  const m = String(url).match(/-sm-([a-z0-9]+)\/?$/i);
  return m ? 'SM-' + m[1].toUpperCase() : '';
}

async function discoverFamilies() {
  const res = await fetch('https://www.samsung.com.cn/im-sitemap.xml', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`三星 sitemap HTTP ${res.status}`);
  const xml = await res.text();
  const urls = [...new Set(
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => m[1].trim())
      .filter((u) =>
        /\/smartphones\//.test(u) &&
        !/\/buy\/|\/specs\/|\/reviews\/|\/compare\/|\/design\/|\/experience\/|\/upgrade\/|buy_test/.test(u) &&
        !/\/smartphones\/(?:galaxy-[a-z]|galaxy-z)\/$/.test(u)
      )
  )];
  const groups = new Map();
  for (const url of urls) {
    const key = familyKey(url);
    if (!groups.has(key)) groups.set(key, { key, url, code: fullModelCode(url) });
  }
  return [...groups.values()];
}

async function modelCodeFor(family) {
  if (family.code) return family.code;
  const res = await fetch(family.url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return '';
  const html = await res.text();
  return html.match(/data-model-code="([^"]+)"/)?.[1] || '';
}

function sectionsFromSpec(spec) {
  const out = [];
  for (const item of spec?.specItems || []) {
    const label = clean(item.attrName);
    let value = clean(item.attrValue);
    if (!value && Array.isArray(item.attrs)) {
      value = item.attrs
        .filter((a) => clean(a.attrValue))
        .map((a) => `${clean(a.attrName)}：${clean(a.attrValue)}`)
        .join('\n');
    }
    if (label && value) out.push({ label, value });
  }
  return out;
}

async function main() {
  const candidates = loadCandidates();
  const index = buildIndex(candidates);
  const families = (await discoverFamilies()).slice(0, LIMIT);
  console.log(`\n📦 三星官网：${families.length} 个手机家族；候选池 ${candidates.length} 个三星手机`);

  const specs = [];
  const skipped = [];
  const errors = [];

  for (const family of families) {
    try {
      const code = await modelCodeFor(family);
      if (!code) {
        skipped.push(`${family.url}（找不到型号代码）`);
        continue;
      }

      const api = 'https://searchapi.samsung.com.cn/v6/front/b2c/product/spec/detail'
        + `?siteCode=cn&modelList=${encodeURIComponent(code)}&specAnnotationYN=Y`;
      const res = await fetch(api, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`spec API HTTP ${res.status}`);
      const json = await res.json();
      const spec = json?.response?.resultData?.modelList?.[0]?.spec;
      const sections = sectionsFromSpec(spec);
      if (sections.length < 2) {
        skipped.push(`${cleanSlugModel(family.url)}（没有足够参数）`);
        continue;
      }

      const officialModel = cleanSlugModel(family.url);
      const matches = index.get(modelKey(officialModel)) || [];
      if (matches.length !== 1) {
        skipped.push(`${officialModel}（候选池无唯一匹配）`);
        continue;
      }
      const candidate = matches[0];
      const slug = new URL(family.url).pathname.split('/').filter(Boolean).pop();
      specs.push({
        id: `samsung-${slug}`,
        brand: candidate.brand,
        model: candidate.model,
        display: candidate.display,
        category: candidate.category,
        sourceBrand: '三星',
        officialTitle: officialModel,
        sourceUrl: family.url,
        fetchedAt: new Date().toISOString(),
        sections,
      });
      console.log(`   ✓ ${officialModel} → ${candidate.display}（${sections.length} 项）`);
    } catch (e) {
      errors.push(`${family.url} → ${e.message}`);
      console.log(`   ✗ ${family.url}（${e.message}）`);
    }
    await sleep(DELAY);
  }

  const best = new Map();
  for (const s of specs) {
    const key = compact(s.brand + '|' + s.model);
    const prev = best.get(key);
    if (!prev || s.sections.length > prev.sections.length) best.set(key, s);
  }
  const finalSpecs = [...best.values()].sort((a, b) => a.display.localeCompare(b.display, 'zh'));

  console.log(`\n✅ 已匹配并解析：${finalSpecs.length} 个已有型号`);
  console.log(`   未匹配或无参数：${skipped.length} 个家族`);
  if (errors.length) console.log(`   请求失败：${errors.length} 个家族`);

  if (DRY_RUN) {
    console.log('   --dry-run：不写文件');
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'samsung-official',
    count: finalSpecs.length,
    specs: finalSpecs,
  }, null, 2), 'utf8');
  console.log(`\n   输出：${OUT}`);
}

main().catch((err) => {
  console.error('❌ 未预期的错误：', err);
  process.exit(1);
});
