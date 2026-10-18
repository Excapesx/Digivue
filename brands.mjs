#!/usr/bin/env node
/* ============================================================
 * 品牌官网采集：型号名称 + 官方参数（第一版：Apple / 华为）
 * ------------------------------------------------------------
 * 数据来源（官方，可溯源）：
 *   苹果中国  https://www.apple.com.cn/sitemap.xml         → /specs/ 页
 *   华为中国  https://consumer.huawei.com/cn/sitemap.xml   → /specs/ 页
 *
 * 做法：
 *   1. 读 sitemap，找出所有 /specs/ 页面
 *   2. 抓 HTML，用 Playwright 按品牌的选择器抽「小节 → 内容」
 *      Apple:  .techspecs-row
 *      Huawei: .large-accordion__button（下一块就是参数内容）
 *   3. 输出：
 *      data/candidates-brands.json   型号名称（喂给型号库）
 *      data/specs-draft.json         官方参数草稿（喂给参数页）
 *
 * 约束：只抓 /specs/ 页面、1 秒一页、UA 标明用途；不抓图片、不绕验证码。
 *
 * 用法：
 *   node brands.mjs --limit 4 --only apple,huawei     # 先试几个
 *   node brands.mjs --limit 300                       # 全量（Apple 26 + 华为 277）
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const UA = 'digivue-bot/1.0 (+https://digivue.top)';
const DELAY = 1200;

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const LIMIT = Math.max(1, Number(flag('limit', 40)) || 40);
const ONLY = String(flag('only', 'apple,huawei')).split(',').map((s) => s.trim());
const DRY_RUN = Boolean(flag('dry-run', false));

/* ---------- Playwright / 浏览器 ---------- */
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
const EXE = process.env.CHROME_PATH
  || 'C:/Program Files/Edge/App/116.0.1938.76/msedge.exe';

/* ---------- 品牌配置 ---------- */
const BRANDS = [
  {
    id: 'apple', name: '苹果',
    sitemap: 'https://www.apple.com.cn/sitemap.xml',
    mode: 'row', selector: '.techspecs-row',
    drop: /Apple 2030|材料|包装$|能源$|废弃物|化学工艺|换购|年年焕新|Trade In/,
    category(url) {
      if (/\/iphone/.test(url)) return 'phone';
      if (/\/ipad/.test(url)) return 'tablet';
      if (/\/mac-mini|\/imac|\/mac-studio/.test(url)) return 'desktop';
      if (/\/macbook|\/mac-|\/mac$/.test(url)) return 'laptop';
      if (/apple-watch|apple-vision/.test(url)) return 'wearable';
      if (/studio-display|pro-display/.test(url)) return 'peripheral';
      return 'accessory';
    },
  },
  {
    id: 'huawei', name: '华为',
    sitemap: 'https://consumer.huawei.com/cn/sitemap.xml',
    mode: 'accordion', selector: '.large-accordion__button',
    drop: /^$/,
    category(url) {
      if (/\/phones\//.test(url)) return 'phone';
      if (/\/tablets\//.test(url)) return 'tablet';
      if (/\/wearables\//.test(url)) return 'wearable';
      if (/\/laptops\//.test(url)) return 'laptop';
      if (/\/routers\/|\/networking\//.test(url)) return 'peripheral';
      return 'accessory';
    },
  },
];

/* ---------- 工具 ---------- */
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const compact = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[-_/]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 spec URL 取 slug：iphone-18-pro / changxiang-70s */
function slugOf(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const i = parts.lastIndexOf('specs');
  return (i > 0 ? parts[i - 1] : parts[parts.length - 1] || 'model').replace(/[^a-z0-9-]/gi, '');
}

/** 页面标题 → 型号名 */
function modelFrom(title, h1, brandName) {
  let s = clean(h1 || '') || clean(title || '');
  s = s.replace(/[-|–].*$/, '').trim();                    /* 去掉「- Apple (中国大陆)」 */
  s = s.replace(/(技术规格|规格参数|规格|参数)$/g, '').trim();
  s = s.replace(new RegExp('^' + brandName), '').trim();
  /* 型号里重复的拉丁品牌（HUAWEI X → X） */
  s = s.replace(/^(HUAWEI|Apple)\s*/i, '').trim();
  return s || clean(h1) || clean(title);
}

/** 抓 sitemap 里的 /specs/ 页面 */
async function specUrls(brand) {
  const res = await fetch(brand.sitemap, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${brand.name} sitemap HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1].trim())
    .filter((u) => /\/specs\/$/.test(u));
}

/* ---------- 主流程 ---------- */
async function main() {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage();
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(t)) return route.abort();
    return route.continue();
  });

  const candidates = [];
  const specs = [];
  const errors = [];

  for (const brand of BRANDS.filter((b) => ONLY.includes(b.id))) {
    let urls = [];
    try {
      urls = (await specUrls(brand)).slice(0, LIMIT);
    } catch (e) {
      console.error(`❌ ${brand.name} sitemap 失败：${e.message}`);
      continue;
    }
    console.log(`\n📦 ${brand.name}：${urls.length} 个 spec 页面`);

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
        console.log(`   ✗ ${slugOf(url)}（${e.message}）`);
        await sleep(DELAY);
        continue;
      }

      try {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        const raw = await page.evaluate(({ mode, selector }) => {
          const rows = [...document.querySelectorAll(selector)];
          const pairs = rows.map((el) => {
            if (mode === 'row') {
              const kids = [...el.children];
              return {
                label: (kids[0]?.innerText || '').trim(),
                value: kids.slice(1).map((k) => (k.innerText || '').trim()).filter(Boolean).join('\n'),
              };
            }
            return {
              label: (el.innerText || '').trim(),
              value: (el.nextElementSibling?.innerText || '').trim(),
            };
          });
          return {
            title: document.title || '',
            h1: document.querySelector('h1')?.innerText || '',
            pairs,
          };
        }, { mode: brand.mode, selector: brand.selector });

        /* 清洗 + 过滤 */
        const sections = raw.pairs.map((p) => ({
          label: clean(p.label).replace(/\d+$/, ''),       /* 去掉脚注数字：容量1 → 容量 */
          value: clean(p.value),
        })).filter((p) =>
          p.label && p.value &&
          p.label.length <= 30 &&
          p.value.length >= 2 &&
          !brand.drop.test(p.label)
        ).slice(0, 30);

        if (sections.length < 2) {
          console.log(`   ✗ ${slugOf(url)}（没抽到参数）`);
          errors.push(`${url} → 没抽到参数`);
          await sleep(DELAY);
          continue;
        }

        const model = modelFrom(raw.title, raw.h1, brand.name);
        const category = brand.category(url);
        const slug = `${brand.id}-${slugOf(url)}`;
        const display = model.startsWith(brand.name) ? model : `${brand.name} ${model}`;

        candidates.push({
          key: compact(brand.name + '|' + model),
          brand: brand.name,
          model,
          display,
          category,
          source: 'official',
          sourceUrl: url,
          offers: [{ sku: slug, title: model, source: 'official', sourceUrl: url }],
        });
        specs.push({
          id: slug,
          brand: brand.name,
          model,
          display,
          category,
          sourceUrl: url,
          fetchedAt: new Date().toISOString(),
          sections,
        });
        console.log(`   ✓ ${display}（${sections.length} 项）`);
      } catch (e) {
        errors.push(`${url} → ${e.message}`);
        console.log(`   ✗ ${slugOf(url)}（${e.message}）`);
      }
      await sleep(DELAY);
    }
  }

  await browser.close();

  if (DRY_RUN) {
    console.log(`\n--dry-run：不写文件。型号 ${candidates.length} 条，参数页 ${specs.length} 条。`);
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'candidates-brands.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'official-brands',
    count: candidates.length,
    candidates,
  }, null, 2), 'utf8');
  writeFileSync(join(DATA_DIR, 'specs-draft.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'official-brands',
    count: specs.length,
    specs,
  }, null, 2), 'utf8');

  console.log(`\n✅ 完成`);
  console.log(`   官方型号：${candidates.length} 条`);
  console.log(`   官方参数页：${specs.length} 条`);
  if (errors.length) console.log(`   失败：${errors.length} 条（详见上方 ✗）`);
  console.log(`\n   输出：`);
  console.log(`     data/candidates-brands.json`);
  console.log(`     data/specs-draft.json`);
  console.log(`\n   下一步：node build.mjs  生成型号库与参数页`);
}

main().catch((err) => {
  console.error('❌ 未预期的错误：', err);
  process.exit(1);
});
