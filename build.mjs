#!/usr/bin/env node
/* ============================================================
 * digivue 静态站点生成器
 * ------------------------------------------------------------
 * 解决的三个问题：
 *   1. 每个型号有自己的静态页（SEO + 直接分享）
 *   2. 首页的完整产品索引写进 HTML（搜索引擎与无 JS 用户都能读）
 *   3. 工具箱 / 榜单 / AI资讯 三个内页由数据生成，导航全站一致
 *
 * 用法：
 *   node build.mjs
 *
 * 产物（全部输出到 dist/）：
 *   dist/index.html                     首页（由根目录 index.html 注入生成）
 *   dist/phone/redmi-k80/index.html     每款产品一个页面
 *   dist/tools/  dist/ranking/  dist/news/
 *   dist/sitemap.xml  dist/robots.txt
 *   dist/style.css  dist/app.js  dist/data.js  dist/favicon.svg
 *
 * 原理上这里没有魔法：读 data.js → 拼 HTML 字符串 → 写文件。
 * data.js 是浏览器用的全局脚本（不是 ES module），所以用 node:vm
 * 在沙箱里执行它，把变量捞出来，而不是 import。
 * ============================================================ */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');

/* 站点信息 —— 上线后改这里 */
const SITE = {
  name: 'digivue',
  url: 'https://digivue.top',
  tagline: '数码与 AI 社区',
  /* 备案号：拿到后填在这里，重新构建即可出现在页脚；留空则不输出 */
  icp: '',            /* 例：'粤ICP备2026123456号-1'，链接到 beian.miit.gov.cn */
  police: '',         /* 例：'粤公网安备 44030502001234号'，链接到 beian.mps.gov.cn */
  desc: '数码与 AI 的社区站：按参数整理的产品库、预算选机与对比工具，'
      + '以及只收有信源条目的 AI 资讯。',

  /* 资源版本号：改完 style.css / app.js / data.js 把它 +1 */
  assetV: '4',

  /* 搜索引擎归属验证标签。从平台拿到 content 值填这里，留空则不输出 */
  baiduVerify: '',
  bingVerify: '',
  googleVerify: '',
};

/* ============================================================
 * 1. 取出 data.js 里的数据与共用函数
 * ============================================================ */

/* data.js 里的这两个函数由 loadData 覆盖为同一实现 —— 路径规则只留一份 */
let productPath = (p) => `${p.category}/${p.id}/`;
let displayName = (p) => p.name;
let subName = () => '';

function loadData() {
  const src = readFileSync(join(ROOT, 'data.js'), 'utf8');

  /* 在干净的沙箱里执行 data.js，把它定义的变量捞出来。
     比自己写正则解析靠谱得多。 */
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  createContext(sandbox);
  runInContext(
    src + '\n;globalThis.__OUT = { CATEGORIES, SPEC_FIELDS, PRODUCTS, productPath, displayName, subName };',
    sandbox
  );

  const out = sandbox.__OUT;
  if (!out || !Array.isArray(out.PRODUCTS) || out.PRODUCTS.length === 0) {
    throw new Error('data.js 里没有解析到 PRODUCTS，检查文件是否被改动');
  }
  if (typeof out.productPath !== 'function' || typeof out.displayName !== 'function'
      || typeof out.subName !== 'function') {
    throw new Error('data.js 缺少 productPath / displayName / subName 函数');
  }
  productPath = out.productPath;
  displayName = out.displayName;
  subName = out.subName;
  return out;
}

/* ============================================================
 * 2. 合并价格表
 * ------------------------------------------------------------
 * refresh-price.mjs 会把刷新到的价格写进 prices.json。
 * 这里覆盖到产品数据上 —— 页面读的是刷新后的价格。
 * 没有 prices.json 时沿用 data.js 里的初始值，构建不会失败。
 * ============================================================ */

function mergePrices(data) {
  const file = join(ROOT, 'prices.json');
  let store = null;
  if (existsSync(file)) {
    try {
      store = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.warn(`⚠️  prices.json 解析失败，改用 data.js 里的价格：${e.message}`);
    }
  }

  let applied = 0;
  let bound = 0;
  for (const p of data.PRODUCTS) {
    const live = store && store.prices ? store.prices[p.id] : null;
    if (live && typeof live.price === 'number' && live.price > 0) {
      p.price = live.price;
      p.commissionRate = live.commissionRate ?? p.commissionRate ?? 0;
      p.buyUrl = live.buyUrl || null;
      p.platform = live.platform || null;
      p.offers = Array.isArray(live.offers) ? live.offers : [];
      applied++;
    } else {
      p.buyUrl = null;
      p.platform = null;
      p.offers = [];
    }
    if (p.offers.length) bound++;
    p.refreshedAt = (live && live.refreshedAt) || null;
    p.path = '/' + productPath(p);
    p.displayName = displayName(p);
  }

  data.priceUpdatedAt = store ? store.updatedAt : null;
  data.priceProvider = store ? (store.providerLabel || store.provider) : null;
  data.priceApplied = applied;
  data.priceBound = bound;
  return data;
}

/* ============================================================
 * 3. 小工具
 * ============================================================ */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const money = (n) => Number(n).toLocaleString('zh-CN');

/** 渠道显示名（价格来源那一行用） */
const PLATFORM_LABEL = { jd: '京东联盟', tb: '淘宝客', pdd: '多多进宝', mock: '模拟数据' };

/** 品类 id → 品类中文名 */
const catName = (cats, id) => (cats.find((c) => c.id === id) || { name: id }).name;

/** 2026-05-20 → 2026年5月20日 */
function cnDate(d = new Date()) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 把刷新时间戳统一成中文日期 */
function prettyStamp(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return String(s);
  const [, y, mo, d, hh, mm] = m;
  const date = `${y}年${Number(mo)}月${Number(d)}日`;
  return hh ? `${date} ${hh}:${mm}` : date;
}

/* ============================================================
 * 4. 全站共用的页面部件
 * ============================================================ */

const TAG_OPEN = (attrs = '') => '<' + 'script' + (attrs ? ' ' + attrs : '') + '>';
const TAG_CLOSE = '<' + '/' + 'script' + '>';
const JSONLD = (obj) => TAG_OPEN('type="application/ld+json"') + JSON.stringify(obj) + TAG_CLOSE;

/* 内联的图标：统一 1.6px 描边，全站只用这一套 */
const ICON_SEARCH =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/>' +
  '<path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

const ICON_MENU =
  '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
  '<path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

/* 有 JS 才启用入场动效；脚本报错也要看得见 */
function headScript() {
  return `<script>
document.documentElement.classList.add('js');
(function () {
  function show(kind, msg) {
    try {
      var el = document.getElementById('jserr');
      if (!el) return;
      el.hidden = false;
      el.textContent = kind + '：' + msg;
    } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window && e.target.tagName) {
      show('资源加载失败', (e.target.src || e.target.href || '') + ' 无法载入');
      return;
    }
    show('脚本错误', (e.message || '未知') + '（' + (e.filename || '').split('/').pop() + ':' + e.lineno + '）');
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    show('异步错误', (e.reason && e.reason.message) || String(e.reason));
  });
})();
</script>`;
}

function verifyTags() {
  return [
    SITE.baiduVerify ? `<meta name="baidu-site-verification" content="${esc(SITE.baiduVerify)}">` : '',
    SITE.bingVerify ? `<meta name="msvalidate.01" content="${esc(SITE.bingVerify)}">` : '',
    SITE.googleVerify ? `<meta name="google-site-verification" content="${esc(SITE.googleVerify)}">` : '',
  ].filter(Boolean).join('\n');
}

function head({ title, desc, canonical, extra = '' }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#18191b">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(SITE.url + canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(SITE.url + canonical)}">
<meta property="og:site_name" content="${esc(SITE.name)}">
${verifyTags()}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/favicon.svg">
<link rel="stylesheet" href="/style.css?v=${SITE.assetV}">
${headScript()}
${extra}
</head>
<body>
<div id="jserr" class="jserr" role="alert" hidden></div>
<a class="skip-link" href="#main">跳到主要内容</a>`;
}

/* ---------- 主导航：首页 | 工具箱 | 选数码 | AI资讯 | 榜单 | 搜索 ---------- */
function nav(active) {
  const cur = (id) => (active === id ? ' aria-current="page"' : '');
  return `<header class="site-nav">
  <div class="nav-inner">
    <a class="logo" href="/"><span class="logo-mark">◆</span><span class="logo-text" translate="no">${esc(SITE.name)}</span></a>
    <nav class="nav-links" aria-label="主导航">
      <a class="nav-link" href="/" data-nav="home"${cur('home')}>首页</a>
      <a class="nav-link" href="/tools/" data-nav="tools"${cur('tools')}>工具箱</a>
      <a class="nav-link" href="/#board" data-nav="board"${cur('board')}>选数码</a>
      <a class="nav-link" href="/news/"${cur('news')}>AI资讯</a>
      <a class="nav-link" href="/ranking/"${cur('ranking')}>榜单</a>
    </nav>
    <button class="nav-search" type="button" data-open-search aria-label="搜索产品">
      ${ICON_SEARCH}
      搜索 <kbd>/</kbd>
    </button>
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="nav-menu" aria-label="打开菜单">
      ${ICON_MENU}
    </button>
  </div>
  <nav class="nav-menu" id="nav-menu" data-open="false" aria-label="移动端导航">
    <ul>
      <li><a href="/">首页 <span class="menu-note">数码与 AI 社区</span></a></li>
      <li><a href="/tools/">工具箱 <span class="menu-note">全部工具</span></a></li>
      <li><a href="/#board">选数码 <span class="menu-note">产品板</span></a></li>
      <li><a href="/news/">AI资讯 <span class="menu-note">筹备中</span></a></li>
      <li><a href="/ranking/">榜单 <span class="menu-note">按预算档位</span></a></li>
      <li><a href="/models/">型号库 <span class="menu-note">已核验参数</span></a></li>
      <li><button type="button" data-open-search>搜索 <span class="menu-note">型号、品牌、卖点</span></button></li>
    </ul>
  </nav>
</header>`;
}

function searchDialog() {
  return `<dialog class="searchdlg" id="searchdlg" aria-label="搜索产品">
  <div class="search-field">
    ${ICON_SEARCH}
    <input id="search-input" name="q" type="search" placeholder="搜型号、品牌或卖点…" autocomplete="off"
           spellcheck="false" enterkeyhint="search" aria-label="搜索关键词">
    <button type="button" class="search-close" data-search-close aria-label="关闭搜索">×</button>
  </div>
  <div class="search-results" data-search-results aria-live="polite"></div>
  <p class="search-foot" data-search-foot></p>
</dialog>`;
}

function compareChrome() {
  return `<!-- 对比栏：选中 1 款后出现 -->
<div class="comparebar" id="comparebar" hidden>
  <div class="cb-inner">
    <span class="cb-label">对比</span>
    <div class="cb-slots" data-cb-slots></div>
    <span class="cb-hint" data-cb-hint aria-live="polite"></span>
    <button type="button" class="btn btn-quiet" data-cb-clear>清空</button>
    <button type="button" class="btn btn-accent" data-cb-go disabled>开始对比</button>
  </div>
</div>

<!-- 对比结果弹窗 -->
<dialog class="cmpdlg" id="cmpdlg">
  <div class="cmpdlg-head">
    <h2 id="cmp-title">产品对比</h2>
    <button type="button" class="cmpdlg-x" data-cmp-close aria-label="关闭">×</button>
  </div>
  <div class="cmpdlg-body" id="cmp-body"></div>
  <div class="cmpdlg-foot">
    <p class="cmpdlg-tip">高亮行表示存在差异；成交价以下单页为准。</p>
    <button type="button" class="btn btn-quiet" data-cmp-close2>关闭</button>
  </div>
</dialog>`;
}

function footer(data) {
  const stamp = prettyStamp(data.priceUpdatedAt);
  const rawSrc = data.priceProvider ? String(data.priceProvider).replace(/[（）()]/g, '').trim() : '';
  const src = rawSrc ? `（${esc(rawSrc)}）` : '';
  const priceLine = stamp
    ? `<p><strong>关于价格</strong>：参考价更新于 ${esc(stamp)}${src}，成交价以下单页为准。</p>`
    : `<p><strong>关于价格</strong>：参考价，成交价以下单页为准。</p>`;

  /* 备案号：没填就什么都不输出 */
  const filing = [
    SITE.icp
      ? `<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">${esc(SITE.icp)}</a>`
      : '',
    SITE.police
      ? `<a href="https://beian.mps.gov.cn/" target="_blank" rel="noopener">${esc(SITE.police)}</a>`
      : '',
  ].filter(Boolean).join('&nbsp;&nbsp;');

  return `<footer class="site-footer">
  <div class="wrap">
    <p class="footer-word"><span class="logo-mark">◆</span>${esc(SITE.name)}</p>
    <nav class="footer-nav" aria-label="页脚导航">
      <a href="/">首页</a>
      <a href="/tools/">工具箱</a>
      <a href="/#board">选数码</a>
      <a href="/news/">AI资讯</a>
      <a href="/ranking/">榜单</a>
      <a href="/models/">型号库</a>
      <a href="#" data-open-search>搜索</a>
    </nav>
    <div class="footer-notes">
      ${priceLine}
      <p><strong>关于佣金</strong>：推广链接可能带来佣金，不影响你的价格，也不影响排序。</p>
    </div>
    <p class="footer-meta">© ${new Date().getFullYear()} ${esc(SITE.name)}${filing ? '&nbsp;&nbsp;' + filing : ''}</p>
  </div>
</footer>`;
}

/* 统一的页面外壳 */
function page({ active, title, desc, canonical, extra = '', body, withCompare = false }) {
  return `${head({ title, desc, canonical, extra })}
${nav(active)}
<main id="main">
${body}
</main>
${footer({ priceUpdatedAt: PAGE_PRICE_STAMP, priceProvider: PAGE_PRICE_PROVIDER })}
${withCompare ? compareChrome() : ''}
${searchDialog()}
<!-- 顺序不能变：data.js 先定义数据，app.js 再消费 -->
<script src="/data.js?v=${SITE.assetV}"></script>
<script src="/app.js?v=${SITE.assetV}"></script>
</body>
</html>`;
}

/* page() 需要页脚里的价格时间；main() 会先设置这两个变量 */
let PAGE_PRICE_STAMP = null;
let PAGE_PRICE_PROVIDER = null;

/* ============================================================
 * 5. 首页
 * ------------------------------------------------------------
 * 首页的正文（首屏、产品板、规则、FAQ、收尾）只有一份来源：
 * 根目录的 index.html。这里做三件注入：
 *   1. BUILD:HEAD 标记处补 canonical / og / 验证标签
 *   2. BUILD:INDEX 标记处用 data.js 生成完整产品索引（SEO）
 *   3. BUILD:FOOTER 标记处换成带价格时间戳的版本
 * 再把相对路径改成绝对路径，其余原样搬运。
 * ============================================================ */

function injectRegion(html, startMark, endMark, replacement) {
  const start = html.indexOf(startMark);
  const end = html.indexOf(endMark);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`index.html 缺少构建标记：${startMark} / ${endMark}`);
  }
  return html.slice(0, start + startMark.length) + '\n' + replacement + '\n' + html.slice(end);
}

/**
 * 首页的对比演示片段。
 * 挑一对价格最接近、但价格不同的手机，按 data.js 的真实参数生成对比表 ——
 * 旁边那句「两款的差别，一次看清」由这张真实的表来证明，而不是配一张示意图。
 */
function buildCompareDemo(data) {
  const phones = data.PRODUCTS
    .filter((p) => p.category === 'phone')
    .slice()
    .sort((a, b) => a.price - b.price);

  let pair = null;
  for (let i = 0; i < phones.length - 1; i++) {
    const gap = phones[i + 1].price - phones[i].price;
    if (gap > 0 && (!pair || gap < pair.gap)) pair = { gap, a: phones[i], b: phones[i + 1] };
  }
  if (!pair) pair = { a: phones[0], b: phones[1] };
  const { a, b } = pair;

  const fields = (data.SPEC_FIELDS.phone || []).slice(0, 5);
  const fieldRows = fields.map((f) => {
    const va = a.specs[f.key] ?? '—';
    const vb = b.specs[f.key] ?? '—';
    const same = String(va) === String(vb);
    return {
      same,
      html: `          <tr class="cmp-row${same ? '' : ' is-diff'}"><th scope="row">${esc(f.label)}</th><td>${esc(va)}</td><td>${esc(vb)}</td></tr>`,
    };
  });

  const priceSame = a.price === b.price;
  const diffCount = fieldRows.filter((r) => !r.same).length + (priceSame ? 0 : 1);

  const table = `      <table class="cmptable">
        <thead>
          <tr>
            <th scope="col" class="cmp-corner">对比项</th>
            <th scope="col"><a class="cmp-name" href="/${productPath(a)}">${esc(displayName(a))}</a><span class="cmp-brand">${esc(a.brand)}</span></th>
            <th scope="col"><a class="cmp-name" href="/${productPath(b)}">${esc(displayName(b))}</a><span class="cmp-brand">${esc(b.brand)}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr class="cmp-row cmp-row--price${priceSame ? '' : ' is-diff'}"><th scope="row">参考价</th><td><span class="cmp-price">¥${esc(money(a.price))}</span></td><td><span class="cmp-price">¥${esc(money(b.price))}</span></td></tr>
${fieldRows.map((r) => r.html).join('\n')}
        </tbody>
      </table>
      <p class="cmp-note">${fieldRows.length} 项参数，<b>${diffCount}</b> 项有差异（已高亮）。</p>`;

  return `  <section class="wrap capability" aria-label="型号对比">
    <div class="cap-statement" data-reveal>
      <h2>两款的差别，一次看清</h2>
      <p>勾 2 到 3 款，参数按行对齐；不同的行自动亮起。</p>
      <a class="link" href="#board">去产品板试试</a>
    </div>
    <div class="cap-fragment" data-ui data-reveal="2">
${table}
    </div>
  </section>`;
}

/* ============================================================
 * 已核验型号库（只发布参数可追溯的型号）
 * ------------------------------------------------------------
 * 数据来自 data/candidates.json（discover.mjs 产出，默认 Wikidata CC0）。
 * 这里只生成列表页：按大类分页、按品牌分组；已经有参数的产品会链到产品页。
 * 不生成「一个型号一个空页面」，避免几千个薄页面拖累 SEO。
 * ============================================================ */

const MODELS_PER_PAGE = 150;
const compact = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[-_/]/g, '');

function loadModels(data) {
  const ids = new Set(data.CATEGORIES.map((c) => c.id));
  const merged = new Map();

  /* 两个来源：Wikidata 全量名字 + 品牌官网（更准、带参数页） */
  for (const name of ['candidates.json', 'candidates-brands.json']) {
    const file = join(ROOT, 'data', name);
    if (!existsSync(file)) continue;
    try {
      const store = JSON.parse(readFileSync(file, 'utf8'));
      for (const c of (store.candidates || [])) {
        if (!c || !c.display || !ids.has(c.category)) continue;
        const key = compact(c.brand + '|' + c.model);
        const prev = merged.get(key);
        if (prev) {
          /* 官网来源优先：补上 sourceUrl / offers，保留已有字段 */
          prev.offers = [...(prev.offers || []), ...(c.offers || [])];
          prev.sourceUrl = prev.sourceUrl || c.sourceUrl;
          if (c.source === 'official') prev.source = 'official';
        } else {
          merged.set(key, { ...c, key });
        }
      }
    } catch (e) {
      console.warn(`⚠️  data/${name} 读取失败，跳过：${e.message}`);
    }
  }
  return [...merged.values()];
}

function loadSpecs() {
  const files = [
    'specs-draft.json',
    'specs-official-extra.json',
    'specs-samsung.json',
    'specs-canon.json',
    'specs-nikon.json',
  ];
  const byModel = new Map();
  for (const name of files) {
    const file = join(ROOT, 'data', name);
    if (!existsSync(file)) continue;
    try {
      const store = JSON.parse(readFileSync(file, 'utf8'));
      for (const s of (Array.isArray(store.specs) ? store.specs : [])) {
        if (!s || !s.id || !Array.isArray(s.sections) || !s.sections.length) continue;
        const key = compact(s.brand + '|' + s.model);
        const prev = byModel.get(key);
        const normalized = {
          ...s,
          sourceBrand: s.sourceBrand
            || (String(s.id).startsWith('xiaomi-') ? '小米'
              : String(s.id).startsWith('samsung-') ? '三星'
              : String(s.id).startsWith('canon-') ? '佳能'
              : String(s.id).startsWith('nikon-') ? '尼康'
              : s.brand),
        };
        if (!prev || normalized.sections.length > prev.sections.length) byModel.set(key, normalized);
      }
    } catch (e) {
      console.warn(`⚠️  data/${name} 读取失败：${e.message}`);
    }
  }
  return [...byModel.values()];
}

function buildModels(data, models, specs = []) {
  if (!models.length) return { pages: [], urls: [], count: 0, searchItems: [] };

  /* 已有参数的产品：品牌+型号 对上就链过去 */
  const catalog = new Map();
  for (const p of data.PRODUCTS) {
    catalog.set(compact(displayName(p)), p);
    catalog.set(compact(p.brand + p.name), p);
    catalog.set(compact(p.name), p);
  }
  const match = (c) =>
    catalog.get(compact(c.display)) || catalog.get(compact(c.brand + c.model)) || catalog.get(compact(c.model)) || null;

  /* 官网参数页：品牌+型号 对上就链到官方参数页 */
  const specByKey = new Map(specs.map((s) => [compact(s.brand + '|' + s.model), s]));
  const specFor = (c) => specByKey.get(compact(c.brand + '|' + c.model)) || null;
  const hrefFor = (c) => {
    const p = match(c);
    if (p) return '/' + productPath(p);
    const s = specFor(c);
    return s ? `/specs/${s.id}/` : null;
  };
  const hasParams = (c) => Boolean(match(c) || specFor(c));

  /* 完整优先：只发布参数已核验的型号。
     原始候选仍保留在 data/ 里，后续补到可靠来源时可以重新进入公开库。 */
  const published = models.filter(hasParams);
  if (!published.length) return { pages: [], urls: [], count: 0, searchItems: [], hiddenCount: models.length };

  const byCat = new Map();
  for (const c of published) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  const paramCount = published.length;
  const hiddenCount = models.length - published.length;
  const specBrands = [...new Set(specs.map((s) => s.sourceBrand || s.brand).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .join(' / ');

  const pages = [];
  const urls = ['/models/'];
  const cats = data.CATEGORIES.filter((c) => byCat.has(c.id));

  const indexBody = `  <div class="wrap page models-page">
    <nav class="crumbs" aria-label="面包屑">
      <a href="/">首页</a><span class="sep">›</span><a href="/#board">选数码</a><span class="sep">›</span><span>型号库</span>
    </nav>
    <div class="page-head" data-reveal>
      <h1>已核验型号库</h1>
      <p class="lede">${money(published.length)} 个已核验型号，全部可查看参数。</p>
      <p class="note">公开库只收录参数可追溯的型号；另有 ${money(hiddenCount)} 个只有名称、没有可靠参数来源的条目未发布。参数优先取自${esc(specBrands)}官网。</p>
    </div>
    <div class="models-index" data-ui>
${cats.map((c, i) => {
  const items = byCat.get(c.id);
  return `      <a class="model-cat" href="/models/${c.id}/" data-reveal="${(i % 4) + 1}"><b>${esc(c.name)}</b><span>${money(items.length)} 个已核验型号</span></a>`;
}).join('\n')}
    </div>
  </div>`;

  pages.push({
    rel: join('models', 'index.html'),
    html: page({
      active: 'board',
      title: `已核验型号库 · ${money(published.length)} 个数码产品 · ${SITE.name}`,
      desc: `${money(published.length)} 个参数可追溯的数码产品型号，覆盖手机、笔记本、平板、相机、镜头、穿戴与外设。`,
      canonical: '/models/',
      body: indexBody,
    }),
  });

  for (const cat of cats) {
    const items = byCat.get(cat.id).slice().sort((a, b) =>
      String(a.brand).localeCompare(String(b.brand), 'zh') ||
      String(a.display).localeCompare(String(b.display), 'zh'));
    const totalPages = Math.ceil(items.length / MODELS_PER_PAGE);

    for (let pnum = 1; pnum <= totalPages; pnum++) {
      const slice = items.slice((pnum - 1) * MODELS_PER_PAGE, pnum * MODELS_PER_PAGE);
      const groups = [];
      for (const it of slice) {
        const brand = it.brand || '其他';
        let g = groups.find((x) => x.brand === brand);
        if (!g) { g = { brand, items: [] }; groups.push(g); }
        g.items.push(it);
      }

      const rel = pnum === 1
        ? join('models', cat.id, 'index.html')
        : join('models', cat.id, String(pnum), 'index.html');
      const canonical = pnum === 1 ? `/models/${cat.id}/` : `/models/${cat.id}/${pnum}/`;
      urls.push(canonical);

      const pager = totalPages > 1 ? `    <nav class="pager" aria-label="翻页">
      ${pnum > 1 ? `<a class="btn btn-quiet" href="${pnum === 2 ? `/models/${cat.id}/` : `/models/${cat.id}/${pnum - 1}/`}">上一页</a>` : ''}
      <span class="pager-info">第 ${pnum} / ${totalPages} 页</span>
      ${pnum < totalPages ? `<a class="btn btn-quiet" href="/models/${cat.id}/${pnum + 1}/">下一页</a>` : ''}
    </nav>` : '';

      const list = groups.map((g) => `    <div class="brand-block" data-reveal>
      <h2 class="brand-head">${esc(g.brand)}</h2>
      <ul class="model-list">
${g.items.map((it) => {
  const p = match(it);
  const s = specFor(it);
  const href = p ? '/' + productPath(p) : s ? `/specs/${s.id}/` : null;
  const tag = p ? '已有参数' : s ? '官方参数' : '参数待补';
  const name = href
    ? `<a class="model-name" href="${href}">${esc(it.display)}</a>`
    : `<span class="model-name">${esc(it.display)}</span>`;
  return `        <li class="model-row">${name}<span class="model-tag${href ? ' model-tag--ready' : ''}">${tag}</span></li>`;
}).join('\n')}
      </ul>
    </div>`).join('\n');

      const body = `  <div class="wrap page models-page">
    <nav class="crumbs" aria-label="面包屑">
      <a href="/">首页</a><span class="sep">›</span><a href="/#board">选数码</a><span class="sep">›</span>
      <a href="/models/">型号库</a><span class="sep">›</span><span>${esc(cat.name)}</span>
    </nav>
    <div class="page-head" data-reveal>
      <h1>${esc(cat.name)}型号库</h1>
      <p class="lede">共 ${money(items.length)} 个已核验型号，全部可查看参数。</p>
      <p class="note">只展示参数可追溯的型号，按品牌分组；无法核实参数的条目不进入公开库。</p>
    </div>
${list}
${pager}
  </div>`;

      pages.push({
        rel,
        html: page({
          active: 'board',
          title: `${cat.name}已核验型号库 · ${money(items.length)} 个型号 · ${SITE.name}`,
          desc: `${cat.name}已核验型号库：${money(items.length)} 个参数可追溯的型号，按品牌分组。`,
          canonical,
          body,
        }),
      });
    }
  }

  /* 全站搜索用的精简索引：[名称, 分类, 产品页或 null] */
  const searchItems = published.map((c) => {
    return [c.display, c.category, hrefFor(c)];
  });

  return { pages, urls, count: published.length, searchItems, paramCount, hiddenCount };
}

/* 官方参数页：/specs/{品牌-型号}/，内容按官方 spec 页的「小节 → 内容」渲染 */
function buildSpecPages(data, specs) {
  if (!specs.length) return { pages: [], urls: [] };
  const pages = [];
  const urls = [];

  for (const s of specs) {
    const cat = data.CATEGORIES.find((c) => c.id === s.category);
    const catName = cat ? cat.name : '';
    const fetched = s.fetchedAt ? String(s.fetchedAt).slice(0, 10) : '';
    const rows = s.sections
      .map((sec, i) => `<tr data-reveal="${(i % 4) + 1}"><th scope="row">${esc(sec.label)}</th><td>${esc(sec.value)}</td></tr>`)
      .join('\n');

    const body = `  <div class="wrap page spec-page">
    <nav class="crumbs" aria-label="面包屑">
      <a href="/">首页</a><span class="sep">›</span><a href="/#board">选数码</a><span class="sep">›</span>
      <a href="/models/">型号库</a><span class="sep">›</span><span>${esc(s.display)}</span>
    </nav>
    <div class="page-head" data-reveal>
      <h1>${esc(s.display)}</h1>
      <p class="lede">官方规格参数。价格与购买链接待补。</p>
      <p class="note">数据来自${esc(s.brand)}官网${fetched ? `，抓取于 ${esc(fetched)}` : ''}。 <a class="link" href="${esc(s.sourceUrl)}" target="_blank" rel="noopener">查看官方页面</a></p>
    </div>
    <table class="spectable spec-official" data-reveal="2">
      <tbody>
${rows}
      </tbody>
    </table>
    <p class="buyhint">参数以官方页面为准；价格与渠道待接入。回到<a href="/models/${esc(s.category)}/">${esc(catName)}型号库</a>看同类。</p>
  </div>`;

    urls.push(`/specs/${s.id}/`);
    pages.push({
      rel: join('specs', s.id, 'index.html'),
      html: page({
        active: 'board',
        title: `${s.display} 参数 · ${SITE.name}`,
        desc: `${s.display} 官方规格参数（来自${s.brand}官网），价格待补。`,
        canonical: `/specs/${s.id}/`,
        body,
      }),
    });
  }

  return { pages, urls };
}

function buildIndex(data, modelCount = 0, specCount = 0) {
  let html = readFileSync(join(ROOT, 'index.html'), 'utf8');

  const canonical = '/';
  const title = `${SITE.name} · 数码与 AI 社区`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE.name,
    url: SITE.url + '/',
    description: SITE.desc,
  };
  const headExtra = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(SITE.desc)}">`,
    `<meta property="og:url" content="${esc(SITE.url + canonical)}">`,
    `<meta property="og:site_name" content="${esc(SITE.name)}">`,
    verifyTags(),
    JSONLD(jsonLd),
  ].filter(Boolean).join('\n');

  /* 1. head 注入 */
  html = html.replace('<!-- BUILD:HEAD -->', () => [
    `<link rel="canonical" href="${esc(SITE.url + canonical)}">`,
    headExtra,
  ].join('\n'));

  /* 2. 静态产品索引：给搜索引擎和禁用 JS 的用户 */
  const byCat = data.CATEGORIES.map((c) => {
    const items = data.PRODUCTS.filter((p) => p.category === c.id);
    if (!items.length) return '';
    const subs = c.subs || [];
    const line = (p) => `            <li><a href="/${productPath(p)}">${esc(displayName(p))}</a><span class="p">¥${esc(money(p.price))}</span></li>`;

    /* 有细分的大类，索引里也按细分分一下，方便扫 */
    let body;
    if (subs.length) {
      body = subs.map((s) => {
        const list = items.filter((p) => p.sub === s.id);
        if (!list.length) return '';
        return `        <p class="index-sub">${esc(s.name)}</p>
        <ul class="index-list">
${list.map(line).join('\n')}
        </ul>`;
      }).filter(Boolean).join('\n');
    } else {
      body = `        <ul class="index-list">
${items.map(line).join('\n')}
        </ul>`;
    }

    return `      <div class="index-cat">
        <h3>${esc(c.name)}（${items.length} 款）</h3>
${body}
      </div>`;
  }).join('\n');

  const indexSection = `  <section class="wrap index-section" aria-label="全部产品">
    <h2>全部产品</h2>
    <p class="index-note">${data.PRODUCTS.length} 款产品的完整索引，每项都指向静态参数页。</p>
    <div class="index-cats">
${byCat}
    </div>
  </section>`;

  html = injectRegion(html, '<!-- BUILD:INDEX:START -->', '<!-- BUILD:INDEX:END -->', indexSection);

  /* 3. 对比演示片段：用真实参数生成 */
  html = injectRegion(html, '<!-- BUILD:COMPARE:START -->', '<!-- BUILD:COMPARE:END -->', buildCompareDemo(data));

  /* 4. 页脚说明：换成带价格时间戳的版本 */
  const stamp = prettyStamp(data.priceUpdatedAt);
  const rawSrc = data.priceProvider ? String(data.priceProvider).replace(/[（）()]/g, '').trim() : '';
  const src = rawSrc ? `（${esc(rawSrc)}）` : '';
  const footerNotes = `    <div class="footer-notes">
      <p><strong>关于价格</strong>：参考价${stamp ? `更新于 ${esc(stamp)}${src}` : ''}，成交价以下单页为准。</p>
      <p><strong>关于佣金</strong>：推广链接可能带来佣金，不影响你的价格，也不影响排序。</p>
    </div>`;
  html = injectRegion(html, '<!-- BUILD:FOOTER:START -->', '<!-- BUILD:FOOTER:END -->', footerNotes);

  /* 页脚备案号（拿到后填 SITE.icp / SITE.police，重新构建即可） */
  const filing = [
    SITE.icp
      ? `<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">${esc(SITE.icp)}</a>`
      : '',
    SITE.police
      ? `<a href="https://beian.mps.gov.cn/" target="_blank" rel="noopener">${esc(SITE.police)}</a>`
      : '',
  ].filter(Boolean).join('&nbsp;&nbsp;');
  const footerMeta = `    <p class="footer-meta">© ${new Date().getFullYear()} ${esc(SITE.name)}${filing ? '&nbsp;&nbsp;' + filing : ''}</p>`;
  html = injectRegion(html, '<!-- BUILD:FOOTER-META:START -->', '<!-- BUILD:FOOTER-META:END -->', footerMeta);

  /* 型号库入口：只在有型号库数据时出现 */
  const modelsLine = modelCount
    ? `  <p class="board-more">这个产品板只收 <b>${data.PRODUCTS.length}</b> 款精选；<a class="link" href="/models/">进入已核验型号库，共 <b>${money(modelCount)}</b> 个型号，全部可查看参数</a></p>`
    : '';
  html = injectRegion(html, '<!-- BUILD:MODELS:START -->', '<!-- BUILD:MODELS:END -->', modelsLine);

  /* 首屏主入口：型号库是完整规模，精选产品板是另一层 */
  const heroActions = modelCount
    ? `          <a class="btn btn-accent" href="/models/">浏览已核验型号<span class="btn-spark" aria-hidden="true"></span></a>
          <a class="link" href="#board">查看精选产品</a>`
    : `          <a class="btn btn-accent" href="#board">查看精选产品<span class="btn-spark" aria-hidden="true"></span></a>`;
  html = injectRegion(html, '<!-- BUILD:HERO-ACTIONS:START -->', '<!-- BUILD:HERO-ACTIONS:END -->', heroActions);

  /* 4. 相对路径改绝对路径（生成产物部署在站点根目录） */
  const swaps = [
    ['href="style.css?v=2"', `href="/style.css?v=${SITE.assetV}"`],
    ['href="favicon.svg"', 'href="/favicon.svg"'],
    ['href="tools/"', 'href="/tools/"'],
    ['href="news/"', 'href="/news/"'],
    ['href="ranking/"', 'href="/ranking/"'],
    ['href="./"', 'href="/"'],
    ['src="data.js?v=2"', `src="/data.js?v=${SITE.assetV}"`],
    ['src="app.js?v=2"', `src="/app.js?v=${SITE.assetV}"`],
  ];
  for (const [from, to] of swaps) html = html.split(from).join(to);

  return html;
}

/* ============================================================
 * 6. 产品详情页
 * ============================================================ */

function buildProductPage(p, data) {
  const { CATEGORIES, SPEC_FIELDS, PRODUCTS } = data;
  const fields = SPEC_FIELDS[p.category] || [];
  const cname = catName(CATEGORIES, p.category);
  const sname = subName(p.category, p.sub);

  /* 标题写成有人会搜的样子：用户搜的是「Redmi K80 参数 价格」 */
  const title = `${p.name} 参数、价格、值得买吗（${sname || cname}）`;
  const desc = `${displayName(p)} 完整参数：${
    fields.slice(0, 4).map((f) => `${f.label} ${p.specs[f.key] || '—'}`).join('、')
  }。参考价 ¥${money(p.price)}。${(p.tags || []).slice(0, 2).join('、')}。`;

  const specRows = fields
    .filter((f) => p.specs[f.key] !== undefined && p.specs[f.key] !== '')
    .map((f) => `<tr><th scope="row">${esc(f.label)}</th><td>${esc(p.specs[f.key])}</td></tr>`)
    .join('\n        ');

  /* 同类不够 6 个时，用价格最接近的其他品类补上 —— 品类越小，这一块越有用 */
  const sameCat = PRODUCTS
    .filter((x) => x.category === p.category && x.id !== p.id)
    .slice(0, 6);
  const neighbor = PRODUCTS
    .filter((x) => x.category !== p.category)
    .slice()
    .sort((a, b) => Math.abs(a.price - p.price) - Math.abs(b.price - p.price))
    .slice(0, Math.max(0, 6 - sameCat.length));
  const related = [...sameCat, ...neighbor];
  const relatedTitle = neighbor.length ? '同价位参考' : '同类产品';
  const metaOf = (x) => subName(x.category, x.sub) || catName(CATEGORIES, x.category);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    brand: { '@type': 'Brand', name: p.brand },
    category: sname ? `${cname} / ${sname}` : cname,
    description: desc,
    offers: {
      '@type': 'Offer',
      price: p.price,
      priceCurrency: 'CNY',
      availability: 'https://schema.org/InStock',
      url: SITE.url + '/' + productPath(p),
    },
  };

  const body = `  <div class="wrap">
    <nav class="crumbs" aria-label="面包屑">
      <a href="/">首页</a><span class="sep">›</span>
      <a href="/#board">选数码</a><span class="sep">›</span>
      <a href="/#board">${esc(cname)}</a><span class="sep">›</span>
      ${sname ? `<span>${esc(sname)}</span><span class="sep">›</span>` : ''}
      <span>${esc(p.name)}</span>
    </nav>

    <article class="pdetail" data-product-id="${esc(p.id)}">
      <h1 data-reveal>${esc(displayName(p))}</h1>

      <div class="price-panel" data-ui data-reveal="2">
        <p class="pdetail-price">
          <span class="rmb">¥</span>${esc(money(p.price))}
        </p>
        <p class="price-note">${p.platform ? `价格来自${esc(PLATFORM_LABEL[p.platform] || p.platform)}` : '参考价'}${prettyStamp(p.refreshedAt) ? `，更新于 ${esc(prettyStamp(p.refreshedAt))}` : ''}</p>

        ${(p.tags || []).length ? `<div class="tags">${
          p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')
        }</div>` : ''}

        ${p.forWho ? `<p class="forwho"><b>适合：</b>${esc(p.forWho)}</p>` : ''}
      </div>

      <!-- 预算对照：真实控件，滑杆一动就告诉你这款在你的预算里是什么处境 -->
      <div class="console console--product" data-ui data-reveal="3">
        <div class="console-head">
          <label class="console-label" for="budget-${esc(p.id)}">我的预算</label>
          <output class="console-value" data-budget-value for="budget-${esc(p.id)}"><span class="rmb">¥</span>3,000</output>
        </div>
        <div class="slider">
          <span class="slider-track" aria-hidden="true"></span>
          <span class="slider-fill" data-budget-fill aria-hidden="true" style="width:18.92%"></span>
          <input id="budget-${esc(p.id)}" name="budget" data-budget-input data-product-price="${p.price}" type="range"
                 min="200" max="15000" step="100" value="3000" aria-label="我的预算">
        </div>
        <p class="console-fit" data-product-fit></p>
        <div class="console-actions">
          <a class="btn btn-quiet" href="/#board">按这个预算去选</a>
        </div>
      </div>

      <!-- 购买入口：由 app.js 按需填充（有推广链接时才出现） -->
      <div class="pdetail-cta" id="cta" hidden></div>

      <h2 data-reveal>完整参数</h2>
      <div data-ui data-reveal="2">
        <table class="spectable">
          <tbody>
          ${specRows}
          </tbody>
        </table>
      </div>

      <h2 data-reveal>适合谁</h2>
      <div data-reveal="2">
        ${p.forWho ? `<p>${esc(p.forWho)}。</p>` : ''}
        ${(p.tags || []).length ? `<p>主要卖点：${esc((p.tags || []).join('、'))}。</p>` : ''}
        <p class="buyhint">成交价以下单页为准；横向比较回<a href="/#board">选数码</a>，按档位看候选去<a href="/ranking/">榜单</a>。</p>
      </div>

      ${related.length ? `<h2 data-reveal>${relatedTitle}</h2>
      <ul class="plist" data-ui data-reveal="2">
        ${related.map((s) => `<li><a href="/${productPath(s)}">${esc(displayName(s))}</a><span class="p">${s.category !== p.category ? esc(metaOf(s)) + ' ' : ''}¥${esc(money(s.price))}</span></li>`).join('\n        ')}
      </ul>` : ''}
    </article>
  </div>`;

  return page({
    active: '',
    title,
    desc,
    canonical: '/' + productPath(p),
    extra: JSONLD(jsonLd),
    body,
  });
}

/* ============================================================
 * 7. 工具箱 / 榜单 / AI资讯
 * ============================================================ */

function buildToolsPage(data, modelCount = 0, specCount = 0) {
  const n = data.PRODUCTS.length;
  const body = `  <div class="wrap page">
    <div class="page-head" data-reveal>
      <h1>工具箱</h1>
      <p class="lede">这个站上能用的东西，都放在这一页。</p>
      <p class="note">每个工具只做一件事，不用注册。</p>
    </div>

    <!-- 工具箱自己也有一个能用的控件：先定预算，再挑工具 -->
    <div class="console console--product" data-ui data-reveal="2">
      <div class="console-head">
        <label class="console-label" for="budget-tools">我的预算</label>
        <output class="console-value" data-budget-value for="budget-tools"><span class="rmb">¥</span>3,000</output>
      </div>
      <div class="slider">
        <span class="slider-track" aria-hidden="true"></span>
        <span class="slider-fill" data-budget-fill aria-hidden="true" style="width:18.92%"></span>
        <input id="budget-tools" name="budget" data-budget-input type="range"
               min="200" max="15000" step="100" value="3000" aria-label="我的预算">
      </div>
      <div class="console-readout" data-readout></div>
    </div>

    <!-- 现在能用的工具：一张表，状态和入口都在同一行 -->
    <div class="tool-table" data-ui data-reveal="3">
      <table class="spectable">
        <thead>
          <tr><th scope="col">工具</th><th scope="col">做什么</th><th scope="col">打开</th></tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">预算选机</th>
            <td>拖预算，看每个品类里最贴近的型号。</td>
            <td><a class="btn btn-accent" href="/#board">打开</a></td>
          </tr>
          <tr>
            <th scope="row">型号对比</th>
            <td>勾 2 到 3 款，逐项对照，差异自动高亮。</td>
            <td><a class="btn btn-quiet" href="/#board">去对比</a></td>
          </tr>
          <tr>
            <th scope="row">预算榜单</th>
            <td>每档列出该品类里最贴近的 3 款。</td>
            <td><a class="btn btn-quiet" href="/ranking/">看榜单</a></td>
          </tr>
          <tr>
            <th scope="row">全站搜索</th>
            <td>搜型号、品牌、卖点；按 / 随时打开。</td>
            <td><button type="button" class="btn btn-quiet" data-open-search>打开搜索</button></td>
          </tr>
          <tr>
            <th scope="row">型号库</th>
            <td>${modelCount ? `${money(modelCount)} 个已核验型号，全部可查看参数。` : '还没有型号库数据。'}</td>
            <td>${modelCount ? '<a class="btn btn-quiet" href="/models/">去浏览</a>' : '<span class="status">待生成</span>'}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 还没做的：同样一张表，状态写清楚 -->
    <div class="tool-table tool-table--soon" data-ui data-reveal="2">
      <table class="spectable">
        <tbody>
          <tr>
            <th scope="row">装机清单</th>
            <td>主机、显示器、键鼠打包算总价。</td>
            <td><span class="status">筹备中</span></td>
          </tr>
          <tr>
            <th scope="row">保值参考</th>
            <td>发布 12 个月后的价格走向。</td>
            <td><span class="status">筹备中</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="steps" data-ui data-reveal>
      <div class="step" data-reveal><b>先定预算</b><p>拖到心理价位，看还剩几款。</p></div>
      <div class="step" data-reveal="2"><b>再加对比</b><p>勾上拿不准的两三款。</p></div>
      <div class="step" data-reveal="3"><b>最后看参数页</b><p>每款都有独立参数页，可直接分享。</p></div>
    </div>

    <noscript><p class="noscript">搜索与产品板需要 JavaScript。</p></noscript>
  </div>`;

  return page({
    active: 'tools',
    title: `工具箱 · ${SITE.name}`,
    desc: `digivue 的全部工具：预算选机、型号对比、预算榜单和全站搜索。共 ${n} 款完整产品；型号库${modelCount ? `收录 ${money(modelCount)} 个已核验型号，全部可查看参数` : '正在整理'}。`,
    canonical: '/tools/',
    /* 把「型号对比」这个工具直接演示出来（同一份真实参数） */
    body: body + '\n\n' + buildCompareDemo(data).trim(),
  });
}

/* 榜单：每个品类按预算档位取价格最贴近的 3 款 */
const RANK_BRACKETS = {
  phone: [2000, 3000, 5000],
  laptop: [4000, 6000, 9000],
  tablet: [2000, 3000, 5000],
  accessory: [100, 500, 1000],
  desktop: [3000, 5000, 8000],
  wearable: [300, 1500, 3000],
  camera: [3000, 6000, 10000],
  peripheral: [300, 800, 2000],
  lens: [1500, 3000, 6000],
};

function bracketNote(price, budget) {
  const diff = price - budget;
  if (diff === 0) return '正好卡住这个数';
  if (diff > 0) return `超预算 ¥${money(diff)}`;
  if (-diff <= budget * 0.08) return '刚好卡住预算';
  return `预算还有 ¥${money(-diff)} 余量`;
}

function buildRankingPage(data) {
  const blocks = data.CATEGORIES.map((c) => {
    const items = data.PRODUCTS.filter((p) => p.category === c.id);
    const brackets = RANK_BRACKETS[c.id] || [];
    if (!items.length || !brackets.length) return '';

    const rows = brackets.map((budget) => {
      const top = items
        .slice()
        .sort((a, b) => Math.abs(a.price - budget) - Math.abs(b.price - budget) || a.price - b.price)
        .slice(0, 3);

      return `      <div class="bracket" data-ui data-reveal>
        <p class="bracket-label"><b>¥${money(budget)}</b>档，该品类 ${items.length} 款</p>
        <ol class="rank-list">
${top.map((p) => `          <li>
            <span class="rank-no">No.${top.indexOf(p) + 1}</span>
            <span class="rank-name"><a href="/${productPath(p)}">${esc(displayName(p))}</a><span class="rank-note">${esc(bracketNote(p.price, budget))}</span></span>
            <span class="rank-price"><b>¥${esc(money(p.price))}</b>参考价</span>
          </li>`).join('\n')}
        </ol>
      </div>`;
    }).join('\n');

    return `    <div class="rank-block" data-reveal>
      <h2>${esc(c.name)}</h2>
${rows}
    </div>`;
  }).join('\n');

  const body = `  <div class="wrap page">
    <div class="page-head" data-reveal>
      <h1>榜单</h1>
      <p class="lede">每一档预算，取价格最贴近的 3 款。</p>
      <p class="note">不评「性价比」，只回答：这个预算最接近的 3 款是哪几台。</p>
      <div class="head-actions">
        <a class="btn btn-accent" href="/#board">去选数码看全部</a>
      </div>
    </div>
${blocks}
    <div class="steps" data-reveal>
      <div class="step"><b>想知道为什么</b><p>每个型号都有独立参数页；<a class="link" href="/">回首页</a>可以按预算筛。</p></div>
    </div>
  </div>`;

  return page({
    active: 'ranking',
    title: `榜单 · 按预算档位挑数码 · ${SITE.name}`,
    desc: '按预算档位排好的数码产品候选：每一档取该品类里价格最贴近的 3 款，覆盖手机、笔记本、平板与配件。',
    canonical: '/ranking/',
    body,
  });
}

function buildNewsPage(data) {
  const stamp = prettyStamp(data.priceUpdatedAt);
  const statRows = data.CATEGORIES.map((c) => {
    const items = data.PRODUCTS.filter((p) => p.category === c.id);
    if (!items.length) return '';
    const prices = items.map((p) => p.price);
    return `          <tr>
            <th scope="row">${esc(c.name)}</th>
            <td>${items.length} 款</td>
            <td>¥${esc(money(Math.min(...prices)))} – ¥${esc(money(Math.max(...prices)))}</td>
          </tr>`;
  }).filter(Boolean).join('\n');

  const body = `  <div class="wrap page">
    <div class="page-head" data-reveal>
      <h1>AI资讯</h1>
      <p class="lede">这个频道还没开张。</p>
      <p class="note">先说清楚它准备做什么。</p>
      <div class="head-actions" data-reveal="2">
        <a class="btn btn-quiet" href="/ranking/">先看榜单</a>
      </div>
    </div>

    <div class="awaiting" data-reveal="2">
      <h2 data-reveal>只记会改变选购结论的变化</h2>
      <p data-reveal="2">新机发布、价格变化、参数口径调整，只发这类信息。</p>
      <ul>
        <li data-reveal="3">每条都有信源</li>
        <li data-reveal="4">能对应到产品库里的参数</li>
        <li data-reveal="3">不为了填页面而更新</li>
      </ul>
    </div>

    <!-- 频道规格：用产品页同一种表格语言，把规则写清楚 -->
    <div class="spec-fragment" data-ui data-reveal="3">
      <table class="spectable">
        <tbody>
          <tr><th scope="row">更新频率</th><td>服从内容，不为了填满页面而更新</td></tr>
          <tr><th scope="row">每条必须带</th><td>信源链接，指向厂商或官方渠道</td></tr>
          <tr><th scope="row">和产品库的关系</th><td>参数与价格能直接对应到型号页</td></tr>
          <tr><th scope="row">现在状态</th><td>筹备中，尚未开始更新</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 一条资讯会写成什么样：先把格式定下来 -->
    <div class="spec-fragment" data-ui data-reveal="2">
      <table class="spectable">
        <caption>一条资讯会写成什么样</caption>
        <tbody>
          <tr><th scope="row">发生了什么</th><td>一句话，不加形容词</td></tr>
          <tr><th scope="row">信源</th><td>指向厂商或官方渠道的链接</td></tr>
          <tr><th scope="row">对选购的影响</th><td>参数或价格口径变了什么</td></tr>
          <tr><th scope="row">对应的型号</th><td>直接链到产品库里的那一页</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 产品库现状：频道开始更新时，要对应的就是这张表 -->
    <div class="spec-fragment" data-ui data-reveal="2">
      <table class="spectable">
        <caption>产品库现状${stamp ? `（价格更新于 ${esc(stamp)}）` : ''}</caption>
        <thead>
          <tr><th scope="col">品类</th><th scope="col">款数</th><th scope="col">参考价区间</th></tr>
        </thead>
        <tbody>
${statRows}
        </tbody>
      </table>
    </div>

    <!-- 频道开张之前，这些工具已经在工作 -->
    <div class="console console--product" data-ui data-reveal="2">
      <div class="console-head">
        <label class="console-label" for="budget-news">我的预算</label>
        <output class="console-value" data-budget-value for="budget-news"><span class="rmb">¥</span>3,000</output>
      </div>
      <div class="slider">
        <span class="slider-track" aria-hidden="true"></span>
        <span class="slider-fill" data-budget-fill aria-hidden="true" style="width:18.92%"></span>
        <input id="budget-news" name="budget" data-budget-input type="range"
               min="200" max="15000" step="100" value="3000" aria-label="我的预算">
      </div>
      <div class="console-readout" data-readout></div>
      <div class="console-actions">
        <a class="btn btn-quiet" href="/#board">去选数码</a>
      </div>
    </div>
  </div>`;

  return page({
    active: 'news',
    title: `AI资讯 · ${SITE.name}`,
    desc: 'digivue 的 AI 资讯频道正在筹备：只记录会改变选购结论的变化，每条都带信源。',
    canonical: '/news/',
    body,
  });
}

/* ============================================================
 * 8. sitemap / robots
 * ============================================================ */

function buildSitemap(data, extraUrls = []) {
 const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: '/', priority: '1.0' },
    { loc: '/tools/', priority: '0.6' },
    { loc: '/ranking/', priority: '0.8' },
    { loc: '/news/', priority: '0.4' },
    ...extraUrls.map((loc) => ({ loc, priority: '0.5' })),
    ...data.PRODUCTS.map((p) => ({ loc: '/' + productPath(p), priority: '0.8' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${esc(SITE.url + u.loc)}</loc>
    <lastmod>${today}</lastmod>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
}

function buildRobots() {
  return `User-agent: *
Allow: /
Disallow: /.well-known/

Sitemap: ${SITE.url}/sitemap.xml
`;
}

/* ============================================================
 * 9. 主流程
 * ============================================================ */

function write(rel, content) {
  const full = join(DIST, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return rel;
}

/**
 * 清空 dist。
 * Windows 上目录可能被本地预览服务锁住，逐项删除能删多少删多少，
 * 剩下的旧文件随后会被同名覆盖，不影响结果。
 */
function cleanDist() {
  if (!existsSync(DIST)) return;
  try {
    rmSync(DIST, { recursive: true, force: true });
    return;
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e;
    console.warn('⚠️  dist 被占用（多半是本地预览服务正把它当工作目录），改为逐项清理。');
  }
  let stuck = 0;
  for (const entry of readdirSync(DIST)) {
    try {
      rmSync(join(DIST, entry), { recursive: true, force: true });
    } catch {
      stuck++;
    }
  }
  if (stuck) console.warn(`   ${stuck} 项被占用未删除（会被新构建覆盖）`);
}

function main() {
  const data = loadData();
  mergePrices(data);
  PAGE_PRICE_STAMP = data.priceUpdatedAt;
  PAGE_PRICE_PROVIDER = data.priceProvider;

  /* 已核验型号库：有 data/candidates.json 才生成 */
  const models = loadModels(data);
  const specs = loadSpecs();
  const modelLib = buildModels(data, models, specs);
  const specPages = buildSpecPages(data, specs);

  cleanDist();
  mkdirSync(DIST, { recursive: true });

  const written = [];

  written.push(write('index.html', buildIndex(data, modelLib.count, modelLib.paramCount)));

  for (const p of data.PRODUCTS) {
    written.push(write(join(productPath(p), 'index.html'), buildProductPage(p, data)));
  }

  written.push(write('tools/index.html', buildToolsPage(data, modelLib.count, modelLib.paramCount)));
  written.push(write('ranking/index.html', buildRankingPage(data)));
  written.push(write('news/index.html', buildNewsPage(data)));

  for (const m of modelLib.pages) written.push(write(m.rel, m.html));
  for (const m of specPages.pages) written.push(write(m.rel, m.html));

  if (modelLib.count) {
    written.push(write('models.json', JSON.stringify({
      count: modelLib.count,
      items: modelLib.searchItems,
    })));
  }

  written.push(write('sitemap.xml', buildSitemap(data, [...modelLib.urls, ...specPages.urls])));
  written.push(write('robots.txt', buildRobots()));

  /* 渠道映射：给边缘函数用（只有平台 + SKU，没有任何密钥） */
  const offerMap = {};
  for (const p of data.PRODUCTS) {
    if (p.offers && p.offers.length) {
      offerMap[p.id] = p.offers.map((o) => ({
        platform: o.platform,
        sku: o.sku || null,
        itemId: o.itemId || null,
        pid: o.pid || null,
      }));
    }
  }
  written.push(write('offers.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: '型号 → 渠道 SKU 映射，供边缘函数按需取价；不含任何密钥',
    products: offerMap,
  }, null, 2)));

  /* 静态资源原样复制 */
  for (const f of ['style.css', 'app.js', 'data.js', 'favicon.svg']) {
    writeFileSync(join(DIST, f), readFileSync(join(ROOT, f), 'utf8'), 'utf8');
    written.push(f);
  }

  /* 构建报告：自检产物是否齐、页面里是否真的写进了参数文字 */
  const problems = [];
  const home = readFileSync(join(DIST, 'index.html'), 'utf8');
  if (!home.includes('全部产品')) problems.push('首页缺少静态产品索引');
  if (!home.includes('数码看参数')) problems.push('首页缺少首屏标题');
  if (!home.includes('data-open-search')) problems.push('首页缺少全站搜索入口');

  for (const p of data.PRODUCTS) {
    const rel = join(productPath(p), 'index.html');
    const full = join(DIST, rel);
    if (!existsSync(full)) { problems.push(`缺少页面：${rel}`); continue; }
    const html = readFileSync(full, 'utf8');
    /* 参数必须真的以文字形式出现在 HTML 里（这是 SEO 的全部意义） */
    const firstSpec = String(Object.values(p.specs)[0]);
    if (firstSpec && !html.includes(firstSpec) && !html.includes(esc(firstSpec))) {
      problems.push(`${rel} 里没有找到参数文字，JS 渲染将无法被搜索引擎读到`);
    }
    if (!html.includes(`/${productPath(p)}"`)) {
      problems.push(`${rel} 的 canonical 链接不对`);
    }
    if (!html.includes('工具箱')) {
      problems.push(`${rel} 缺少主导航`);
    }
  }

  for (const sub of ['tools', 'ranking', 'news']) {
    const f = join(DIST, sub, 'index.html');
    if (!existsSync(f)) problems.push(`缺少内页：${sub}/index.html`);
  }
  if (modelLib.count) {
    if (!existsSync(join(DIST, 'models', 'index.html'))) problems.push('缺少型号库首页：models/index.html');
    if (!modelLib.pages.length) problems.push('型号库有数据但没有生成页面');
  }
  if (specPages.pages.length) {
    for (const m of specPages.pages.slice(0, 3)) {
      if (!existsSync(join(DIST, m.rel))) problems.push(`缺少官方参数页：${m.rel}`);
    }
  }

  console.log(`\n✅ 构建完成 → dist/`);
  console.log(`   文件总数：${written.length}`);
  console.log(`   主页 1 个 · 产品页 ${data.PRODUCTS.length} 个 · 内页 3 个 · 网址 ${data.PRODUCTS.length + 4} 条`);
  if (modelLib.count) {
    console.log(`   已核验型号库：${money(modelLib.count)} 个型号 · ${modelLib.pages.length} 个列表页`);
    console.log(`   已隐藏：${money(modelLib.hiddenCount)} 个只有名称、没有可靠参数来源的条目`);
  }
  if (specPages.pages.length) {
    const brands = [...new Set(specs.map((s) => s.sourceBrand || s.brand).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh')).join(' / ');
    console.log(`   官方参数页：${money(specPages.pages.length)} 个（${brands}官网）`);
  }
  if (data.priceUpdatedAt) {
    console.log(`   价格来源：${data.priceProvider || '未知'} · 更新于 ${prettyStamp(data.priceUpdatedAt)}`);
    console.log(`   已套用刷新价：${data.priceApplied}/${data.PRODUCTS.length} 款`);
    console.log(`   渠道 SKU：${data.priceBound}/${data.PRODUCTS.length} 款已绑定（其余用参考价）`);
  } else {
    console.log(`   价格来源：data.js 里的初始值（还没跑过 refresh-price.mjs）`);
  }
  if (problems.length) {
    console.log(`\n⚠️  自检发现 ${problems.length} 个问题：`);
    for (const x of problems.slice(0, 20)) console.log('   - ' + x);
    if (problems.length > 20) console.log(`   …还有 ${problems.length - 20} 个`);
  } else {
    console.log(`   自检通过：产品页含真实参数文字，导航与搜索入口齐全`);
  }
  console.log(`\n本地预览：\n   cd dist\n   python -m http.server 8080\n   打开 http://localhost:8080`);
}

main();
