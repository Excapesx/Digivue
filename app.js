/* ============================================================
 * digivue · 交互逻辑 v2
 * ------------------------------------------------------------
 * 纯前端，无框架、无构建步骤、无外部请求。
 *
 * 页面的核心机制：预算滑杆（首屏和产品板上的两个，同一份状态）
 * 一变，读数、产品带、匹配文案全部跟着变。产品在页面上工作。
 *
 * 依赖 data.js 提供的：CATEGORIES / SPEC_FIELDS / PRODUCTS /
 * fetchLivePrice / productPath / displayName
 * ============================================================ */

'use strict';

/* ---------- 常量 ---------- */
const ALL = '__all__';
const MAX_COMPARE = 3;
const SEARCH_LIMIT = 8;

/* ---------- 状态 ---------- */
const state = {
  budget: 3000,
  category: ALL,
  /* 大类里的细分（如智能穿戴 → 智能手表）；null 表示该大类的全部 */
  sub: null,
  query: '',
  sort: 'match',
  /* id -> 价格结果，避免重复打接口 */
  priceCache: new Map(),
  /* 正在对比的产品 id 列表（最多 MAX_COMPARE 个） */
  compare: [],
};

/* ---------- 小工具 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 千分位金额，例：5299 -> "5,299" */
function money(n) {
  return Number(n).toLocaleString('zh-CN');
}

/* ---------- URL 状态 ----------
 * 预算、品类、排序、搜索词都能分享出去：/?budget=5000&cat=phone#board
 * 用 replaceState，不往浏览历史里塞垃圾。 */
const SORTS = ['match', 'price-asc', 'price-desc', 'headroom'];

function syncUrl() {
  if (!$('[data-board-list]')) return;
  const params = new URLSearchParams();
  if (state.query.trim()) params.set('q', state.query.trim());
  if (state.budget !== 3000) params.set('budget', String(state.budget));
  if (state.category !== ALL) params.set('cat', state.category);
  if (state.sub) params.set('sub', state.sub);
  if (state.sort !== 'match') params.set('sort', state.sort);
  const qs = params.toString();
  /* 路径归一化：某些部署环境下 pathname 可能出现重复斜杠，
     直接拼进 replaceState 会抛 SecurityError，把整页渲染带崩。 */
  const path = location.pathname.replace(/\/{2,}/g, '/');
  try {
    history.replaceState(null, '', path + (qs ? '?' + qs : '') + location.hash);
  } catch (err) {
    console.warn('[digivue] 无法同步地址栏状态：', err.message);
  }
}

function readUrlState() {
  const params = new URLSearchParams(location.search);

  const q = params.get('q');
  if (q) state.query = q;

  const budget = Number(params.get('budget'));
  if (Number.isFinite(budget) && budget >= 200 && budget <= 15000) state.budget = budget;

  const cat = params.get('cat');
  if (cat && (cat === ALL || CATEGORIES.some((c) => c.id === cat))) state.category = cat;

  const sub = params.get('sub');
  if (sub && state.category !== ALL && subsOf(state.category).some((s) => s.id === sub)) {
    state.sub = sub;
  }

  const sort = params.get('sort');
  if (sort && SORTS.includes(sort)) state.sort = sort;
}

/** 最简单的 HTML 转义。产品名/参数目前都是自己写的，
 *  但以后接外部数据源时这就是防线，先留着。 */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------- 取值器 ---------- */
const categoryName = (id) =>
  (CATEGORIES.find((c) => c.id === id) || { name: id }).name;

const specFields = (catId) => SPEC_FIELDS[catId] || [];

/** 某个大类定义了的细分（没有细分就返回空数组） */
const subsOf = (catId) => {
  const cat = CATEGORIES.find((c) => c.id === catId);
  return cat && cat.subs ? cat.subs : [];
};

const hrefOf = (p) => '/' + productPath(p);

const titleOf = (p) => displayName(p);

/** 品牌带：把库里出现过的品牌铺成两段（第二段用于无缝循环） */
function renderTicker() {
  const track = $('[data-ticker]');
  if (!track) return;
  const brands = [...new Set(PRODUCTS.map((p) => p.brand))];
  /* --i 让指示灯效果依次亮起（每颗错开 0.42s） */
  const items = brands.map((b, i) => `<span class="ticker-item" style="--i:${i}">${esc(b)}</span>`).join('');
  track.innerHTML =
    `<div class="ticker-group">${items}</div>` +
    `<div class="ticker-group" aria-hidden="true">${items}</div>`;
}

/* ---------- 首屏波场（React Bits 的 Dot Grid / Squares 思路，原生 Canvas 重做） ----------
 * 一层点阵铺在首屏大字下面，像水面一样持续起伏：
 *   · 两层速度不同的斜向行波叠加，慢慢推过整片点阵
 *   · 指针顶起附近一片点并染成强调色
 *   · 指针扫过会在水面上留下扩散的涟漪（最多留 5 圈）
 * 只在首屏可见、标签页在前台时跑；系统开减少动效时只画一帧静止点阵。 */
function initHeroField() {
  const canvas = $('[data-hero-field]');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  const hero = canvas.closest('.hero');
  if (!ctx || !hero) return;

  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mouseLike = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const STEP = window.innerWidth < 700 ? 30 : 24;
  const REACH = 200;
  const BASE_RGB = '166,169,174', HOT_RGB = '255,74,31';

  let w = 0, h = 0, dots = [];
  let pointer = null, ripples = [], lastRipple = { x: 0, y: 0, t: 0 };
  let raf = null, onScreen = true, tabVisible = true;
  const t0 = performance.now();

  const build = () => {
    const rect = hero.getBoundingClientRect();
    w = Math.max(1, Math.round(rect.width));
    h = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dots = [];
    for (let y = STEP; y < h; y += STEP) {
      for (let x = STEP; x < w; x += STEP) dots.push({ x, y });
    }
  };

  const draw = (now) => {
    if (!w || !h) return;
    const t = (now - t0) / 1000;
    ctx.clearRect(0, 0, w, h);

    for (const d of dots) {
      /* 两层速度不同的斜向行波 */
      let wave =
        Math.sin(d.x * 0.0115 + d.y * 0.0042 - t * 1.15) * 0.62 +
        Math.sin(d.x * -0.0051 + d.y * 0.0093 - t * 0.73) * 0.38;

      /* 指针：顶起一片，并把波推高 */
      let hot = 0;
      if (pointer) {
        const dist = Math.hypot(d.x - pointer.x, d.y - pointer.y);
        const k = 1 - dist / REACH;
        if (k > 0) { hot = k * k; wave = wave * (1 - hot * 0.5) + hot * 1.15; }
      }

      /* 指针留下的涟漪：一圈一圈往外扩散 */
      let ring = 0;
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        const age = t - r.t;
        if (age > 1.8) { ripples.splice(i, 1); continue; }
        const dist = Math.hypot(d.x - r.x, d.y - r.y);
        const front = age * 300;
        const band = Math.exp(-Math.pow((dist - front) / 70, 2));
        const decay = 1 - age / 1.8;
        ring += Math.cos((dist - front) * 0.045) * band * decay;
      }
      wave += ring * 1.4;

      const lift = -wave * 4.2 - ring * 3;          /* 上下起伏 */
      const alpha = Math.min(0.85, 0.10 + Math.max(0, wave) * 0.22 + hot * 0.7);
      const size = 1.5 + Math.max(0, wave) * 1.1 + hot * 2.2;
      const rgb = hot > 0.28 ? HOT_RGB : BASE_RGB;

      ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
      ctx.fillRect(d.x - size / 2, d.y - size / 2 + lift, size, size);
    }
  };

  const loop = (now) => {
    if (!onScreen || !tabVisible) { raf = null; return; }
    draw(now);
    raf = requestAnimationFrame(loop);
  };
  const start = () => { if (!reduced && !raf && onScreen && tabVisible) raf = requestAnimationFrame(loop); };
  const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = null; } };

  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    /* 扫过一段距离就丢一圈涟漪（限流 + 最多留 5 圈） */
    const now = performance.now();
    const moved = Math.hypot(pointer.x - lastRipple.x, pointer.y - lastRipple.y);
    if (moved > 44 && now - lastRipple.t > 90) {
      ripples.push({ x: pointer.x, y: pointer.y, t: (now - t0) / 1000 });
      if (ripples.length > 5) ripples.shift();
      lastRipple = { x: pointer.x, y: pointer.y, t: now };
    }
  };
  const onLeave = () => { pointer = null; };

  build();
  draw(performance.now());
  if (reduced) return;                 /* 减少动效：画完这一帧就结束 */

  if (mouseLike) {
    hero.addEventListener('pointermove', onMove, { passive: true });
    hero.addEventListener('pointerleave', onLeave, { passive: true });
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      onScreen = entries[0].isIntersecting;
      if (onScreen) start(); else stop();
    }, { threshold: 0 }).observe(hero);
  }
  document.addEventListener('visibilitychange', () => {
    tabVisible = !document.hidden;
    if (tabVisible) start(); else stop();
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { build(); draw(performance.now()); }, 140);
  });

  start();
}

/* ---------- 点击火花（React Bits 的 Click Spark） ---------- */
function initSparks() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (typeof document.body.animate !== 'function') return;   /* 老浏览器直接跳过 */

  document.addEventListener('pointerdown', (e) => {
    const target = e.target.closest('.btn, .tab, .subtab, .preset, .sort-btn, .dir-row, .band');
    if (!target) return;
    const ink = target.closest('.directory, .field');
    for (let i = 0; i < 6; i++) {
      const s = document.createElement('span');
      s.className = 'spark' + (ink ? ' spark--ink' : '');
      s.style.left = e.clientX + 'px';
      s.style.top = e.clientY + 'px';
      s.style.margin = '-3px 0 0 -3px';
      document.body.appendChild(s);
      const a = (Math.PI * 2 * i) / 6 + Math.random() * 0.6;
      const d = 24 + Math.random() * 22;
      s.animate([
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${(Math.cos(a) * d).toFixed(1)}px, ${(Math.sin(a) * d).toFixed(1)}px) scale(.4)`, opacity: 0 },
      ], { duration: 460, easing: 'cubic-bezier(.22,1,.36,1)' }).onfinish = () => s.remove();
    }
  }, { passive: true });
}

/** 目录带里的规模数字：由 data.js 实时填，并从 0 数上去一次（减少动效时直接落位） */
function renderSiteIndex() {
  const els = $$('[data-si-products]');
  /* 首屏按钮上的款数也跟着数据走 */
  for (const el of $$('[data-si-total]')) el.textContent = String(PRODUCTS.length);
  if (!els.length) return;

  const subs = CATEGORIES.reduce((n, c) => n + (c.subs ? c.subs.length : 0), 0);
  const total = PRODUCTS.length;
  const cats = CATEGORIES.length;
  const text = (n) => `${n} 款精选 · ${cats} 大类 · ${subs} 个细分`;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced || typeof requestAnimationFrame !== 'function') {
    els.forEach((el) => { el.textContent = text(total); });
    return;
  }

  /* 数字先乱跳再落位（React Bits 的 Decrypted Text 那类效果） */
  const dur = 760;
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const settled = text(Math.round(total * eased));
    els.forEach((el) => {
      el.textContent = settled.replace(/\d/g, (d) => (Math.random() < 0.45 ? String(Math.floor(Math.random() * 10)) : d));
    });
    if (p < 1) requestAnimationFrame(tick);
    else els.forEach((el) => { el.textContent = text(total); });
  };
  requestAnimationFrame(tick);
}

/* ---------- 筛选与排序 ----------
 * 排序函数一律不读 commissionRate —— 佣金不参与推荐。
 * 这是本站的立身之本，改代码时请守住。 */
function visibleProducts() {
  const q = state.query.trim().toLowerCase();

  return PRODUCTS.filter((p) => {
    if (state.category !== ALL && p.category !== state.category) return false;
    if (state.sub && p.sub !== state.sub) return false;
    if (!q) return true;
    /* 型号、品牌、卖点、品类、细分都参与搜索 —— 用户记得的可能是任何一项 */
    const haystack = [p.name, p.brand, categoryName(p.category), subName(p.category, p.sub), ...(p.tags || [])]
      .join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

/* 品类之间没有可比性，所以默认先分组、组内再排 */
const CATEGORY_ORDER = CATEGORIES.map((c) => c.id);

/** 组内排序：只比较价格和名字，不碰品类，也不碰佣金 */
function compareBy(sort) {
  switch (sort) {
    case 'price-asc':
    case 'headroom':
      /* 预算余量最多 = 越便宜越靠前 */
      return (a, b) => a.price - b.price || a.name.localeCompare(b.name, 'zh');
    case 'price-desc':
      return (a, b) => b.price - a.price || a.name.localeCompare(b.name, 'zh');
    case 'match':
    default:
      /* 最合适：尽量贴近预算（把钱花在刀刃上），超预算由调用方过滤 */
      return (a, b) => b.price - a.price || a.name.localeCompare(b.name, 'zh');
  }
}

/** 把列表切成 [{ catId, catName, subName, items }]；同品类聚在一起，
 *  选了某个有细分的大类时（且没有指定细分），再按细分分组。 */
function groupProducts(list, sort) {
  const cmp = compareBy(sort);
  const groups = [];
  const splitSubs = state.category !== ALL && !state.sub;

  for (const catId of CATEGORY_ORDER) {
    const subs = subsOf(catId);

    if (splitSubs && subs.length) {
      for (const s of subs) {
        const items = list.filter((p) => p.category === catId && p.sub === s.id).sort(cmp);
        if (items.length) {
          groups.push({ catId, catName: categoryName(catId), subName: s.name, items });
        }
      }
      continue;
    }

    const items = list.filter((p) => p.category === catId).sort(cmp);
    if (items.length) groups.push({ catId, catName: categoryName(catId), items });
  }
  return groups;
}

/* ---------- 价格 ---------- */
async function getPrice(product) {
  if (state.priceCache.has(product.id)) return state.priceCache.get(product.id);
  let result;
  try {
    result = await fetchLivePrice(product);
  } catch (err) {
    console.warn('[digivue] 取价失败：', product.id, err);
    result = { ok: false, source: 'error', price: product.price, commissionRate: 0, buyUrl: null };
  }
  state.priceCache.set(product.id, result);
  return result;
}

/** 价格与预算的关系 —— 这是整个站点的核心信息，所以说人话 */
function priceFit(price, budget) {
  const diff = budget - price;
  if (diff < 0) return { cls: 'band-fit--over', text: `超预算 ¥${money(-diff)}` };
  if (diff <= budget * 0.08) return { cls: 'band-fit--best', text: '刚好卡住预算' };
  return { cls: '', text: `预算还有 ¥${money(diff)} 余量` };
}

/* ============================================================
 * 预算控制台：页面上的两个滑杆共用这一份状态
 * ============================================================ */

function budgetPct(v) {
  const input = $('[data-budget-input]');
  const min = input ? Number(input.min) : 200;
  const max = input ? Number(input.max) : 15000;
  if (!(max > min)) return 0;
  return Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100));
}

function setBudget(v, { render = true } = {}) {
  state.budget = v;

  for (const input of $$('[data-budget-input]')) {
    if (Number(input.value) !== v) input.value = String(v);
    input.setAttribute('aria-valuetext', `¥${money(v)}`);
  }
  for (const out of $$('[data-budget-value]')) {
    out.innerHTML = `<span class="rmb">¥</span>${esc(money(v))}`;
  }
  for (const fill of $$('[data-budget-fill]')) {
    fill.style.width = budgetPct(v).toFixed(2) + '%';
  }
  for (const b of $$('[data-preset]')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.preset) === v));
  }

  syncUrl();
  if (render) renderBoard();
}

let lastReadoutCount = null;

/** 读数：预算内几款、各品类几款、最贴近预算的是谁 */
function renderReadout() {
  const inBudget = PRODUCTS.filter((p) => p.price <= state.budget);
  const counts = CATEGORIES
    .map((c) => `${c.name} ${inBudget.filter((p) => p.category === c.id).length}`)
    .join('、');

  /* 数值变了轻微跳一下：让「拖滑杆 → 读数变化」有反馈 */
  const changed = lastReadoutCount !== null && lastReadoutCount !== inBudget.length;
  lastReadoutCount = inBudget.length;

  /* 「最贴近预算」= 预算内最贵的那款，和产品板的默认排序同一个逻辑 */
  const best = inBudget.reduce((a, b) => (!a || b.price > a.price ? b : a), null);

  let bestHtml;
  if (!best) {
    bestHtml = '<p class="readout-best">这个预算里暂时没有型号。</p>';
  } else {
    const fit = priceFit(best.price, state.budget);
    const tail = fit.cls === 'band-fit--best'
      ? '刚好卡住预算'
      : `还余 ¥${money(state.budget - best.price)}`;
    bestHtml = `<p class="readout-best">最贴近预算：` +
      `<a class="link" href="${esc(hrefOf(best))}">${esc(titleOf(best))}</a>，${esc(tail)}</p>`;
  }

  for (const el of $$('[data-readout]')) {
    el.innerHTML =
      `<p class="readout-count"><b>${inBudget.length}</b> 款在预算内</p>` +
      `<p class="readout-cats">${esc(counts)}</p>` +
      bestHtml;
  }

  if (changed) {
    for (const b of $$('[data-readout] .readout-count b')) {
      b.classList.remove('is-pulse');
      void b.offsetWidth;          /* 强制重排，动画才能重播 */
      b.classList.add('is-pulse');
    }
  }
}

function initBudgetControls() {
  for (const input of $$('[data-budget-input]')) {
    input.addEventListener('input', () => setBudget(Number(input.value)));
  }

  /* 预设：事件委托，一个监听器覆盖所有控制台里的按钮 */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    const v = Number(btn.dataset.preset);
    if (Number.isFinite(v)) setBudget(v);
  });

  setBudget(state.budget, { render: false });
  /* 没有产品板的页面（工具箱）也要有读数 */
  renderReadout();
}

/* ============================================================
 * 产品板
 * ============================================================ */

/** 品类标签（左侧竖排，窄屏横排） */
function renderTabs() {
  const box = $('[data-tabs]');
  if (!box) return;

  box.textContent = '';
  const items = [
    { id: ALL, name: '全部', count: PRODUCTS.length },
    ...CATEGORIES.map((c) => ({
      id: c.id,
      name: c.name,
      count: PRODUCTS.filter((p) => p.category === c.id).length,
    })),
  ];

  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    btn.dataset.cat = it.id;
    btn.setAttribute('aria-pressed', String(it.id === state.category));
    btn.innerHTML =
      `<span class="tab-name">${esc(it.name)}</span>` +
      `<span class="tab-count">${it.count} 款精选</span>`;
    btn.addEventListener('click', () => {
      state.category = it.id;
      state.sub = null;          /* 换大类就回到「全部细分」 */
      syncUrl();
      renderTabs();
      renderSubTabs();
      renderBoard();
    });
    box.appendChild(btn);
  }
}

/** 细分筛选条：只在选中的大类有细分时出现 */
function renderSubTabs() {
  const box = $('[data-subtabs]');
  if (!box) return;

  const subs = state.category === ALL ? [] : subsOf(state.category);
  box.textContent = '';
  box.hidden = subs.length === 0;
  if (!subs.length) return;

  const items = [
    { id: null, name: '全部', count: PRODUCTS.filter((p) => p.category === state.category).length },
    ...subs.map((s) => ({
      id: s.id,
      name: s.name,
      count: PRODUCTS.filter((p) => p.category === state.category && p.sub === s.id).length,
    })),
  ];

  for (const it of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'subtab';
    btn.dataset.sub = it.id || '';
    btn.setAttribute('aria-pressed', String(it.id === state.sub));
    btn.textContent = `${it.name} ${it.count}`;
    btn.addEventListener('click', () => {
      state.sub = it.id;
      syncUrl();
      renderSubTabs();
      renderBoard();
    });
    box.appendChild(btn);
  }
}

/** 排序按钮（产品板上方一行） */
function renderSort() {
  const box = $('[data-sort]');
  if (!box) return;

  const options = [
    { id: 'match', name: '最合适' },
    { id: 'price-asc', name: '价格从低到高' },
    { id: 'price-desc', name: '价格从高到低' },
    { id: 'headroom', name: '余量最多' },
  ];

  box.textContent = '';
  for (const o of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sort-btn';
    btn.dataset.sort = o.id;
    btn.setAttribute('aria-pressed', String(o.id === state.sort));
    btn.textContent = o.name;
    btn.addEventListener('click', () => {
      state.sort = o.id;
      syncUrl();
      renderSort();
      renderBoard();
    });
    box.appendChild(btn);
  }
}

/** 一条产品带：价格 + 型号参数 + 两个动作 */
function buildBand(product, { isBest }) {
  const band = document.createElement('article');
  band.className = 'band' + (isBest ? ' band--best' : '');
  band.dataset.id = product.id;

  /* 价格区（异步价格回来后再刷新） */
  const fit = priceFit(product.price, state.budget);
  const price = document.createElement('div');
  price.className = 'band-price';
  price.innerHTML =
    `<span class="amount" data-price-amount><span class="rmb">¥</span>${esc(money(product.price))}</span>` +
    `<span class="band-fit ${fit.cls}" data-price-fit>${esc(fit.text)}</span>`;
  band.appendChild(price);

  /* 主体：型号 + 关键参数 + 适合谁 */
  const main = document.createElement('div');
  main.className = 'band-main';
  const fields = specFields(product.category);
  const specLine = fields
    .slice(0, 4)
    .map((f) => product.specs[f.key])
    .filter((v) => v !== undefined && v !== null && v !== '')
    .join('、');
  main.innerHTML =
    `<div class="band-name"><a href="${esc(hrefOf(product))}">${esc(titleOf(product))}</a></div>` +
    (specLine ? `<p class="band-specs">${esc(specLine)}</p>` : '') +
    (product.forWho ? `<p class="band-for">适合：${esc(product.forWho)}</p>` : '');
  band.appendChild(main);

  /* 动作：加入对比 + 详情 */
  const actions = document.createElement('div');
  actions.className = 'band-actions';
  const cmpBtn = document.createElement('button');
  cmpBtn.type = 'button';
  cmpBtn.className = 'btn-compare';
  cmpBtn.dataset.compare = product.id;
  cmpBtn.setAttribute('aria-pressed', String(isComparing(product.id)));
  cmpBtn.textContent = isComparing(product.id) ? '已加入' : '＋ 对比';
  cmpBtn.addEventListener('click', () => toggleCompare(product.id));
  const detail = document.createElement('a');
  detail.className = 'link';
  detail.href = hrefOf(product);
  detail.textContent = '看参数';
  actions.append(cmpBtn, detail);
  band.appendChild(actions);

  /* 异步补上真实价格 */
  getPrice(product).then((info) => {
    if (!info || !info.ok || typeof info.price !== 'number' || info.price === product.price) return;
    const f2 = priceFit(info.price, state.budget);
    const amount = $('[data-price-amount]', band);
    const fitEl = $('[data-price-fit]', band);
    if (amount) amount.innerHTML = `<span class="rmb">¥</span>${esc(money(info.price))}`;
    if (fitEl) {
      fitEl.className = 'band-fit ' + f2.cls;
      fitEl.textContent = f2.text;
    }
  });

  return band;
}

function renderBoard() {
  const list = $('[data-board-list]');
  const countEl = $('[data-board-count]');
  const empty = $('[data-board-empty]');
  if (!list || !countEl) return;

  const matched = visibleProducts();
  const inBudget = matched.filter((p) => p.price <= state.budget);
  const overCount = matched.length - inBudget.length;

  /* 计数行：查询词出现时说明当前在看什么，并给一个清除入口 */
  const parts = [`<b>${inBudget.length}</b> 款精选在预算内`];
  if (overCount > 0) parts.push(`${overCount} 款精选超预算已隐藏`);
  if (state.query.trim()) {
    parts.push(
      `正在筛选“${esc(state.query.trim())}”` +
      ` <a class="link" href="#" data-clear-query>清除</a>`
    );
  }
  countEl.innerHTML = parts.join('，');

  const groups = groupProducts(inBudget, state.sort);
  const single = groups.length <= 1;

  list.textContent = '';
  for (const g of groups) {
    if (!single) {
      const head = document.createElement('div');
      head.className = 'group-title';
      /* 按细分分组时，左侧大类标签已经写着大类名，标题只写细分名 */
      head.innerHTML =
        `<h3>${esc(g.subName || g.catName)}</h3>` +
        `<span class="n">${g.items.length} 款</span>`;
      list.appendChild(head);
    }

    const bands = document.createElement('div');
    bands.className = 'bands';
    bands.dataset.items = String(g.items.length);
    /* 这是产品自己的列表片段（真实接口，不是示意），标记出来 */
    bands.setAttribute('data-ui', '');
    for (const p of g.items) {
      bands.appendChild(buildBand(p, {
        isBest: state.sort === 'match' && p === g.items[0],
      }));
    }
    list.appendChild(bands);
  }

  /* 渲染状态写进 DOM：看不见页面时也能靠抓取 HTML 判断脚本是否跑过 */
  list.dataset.rendered = 'true';
  list.dataset.count = String(inBudget.length);

  if (empty) empty.hidden = inBudget.length > 0;
  renderReadout();
}

/* ============================================================
 * 对比：最多三款，纯前端，刷新即清空
 * ============================================================ */

const compareProducts = () => state.compare
  .map((id) => PRODUCTS.find((p) => p.id === id))
  .filter(Boolean);

function isComparing(id) {
  return state.compare.includes(id);
}

function toggleCompare(id) {
  const i = state.compare.indexOf(id);
  if (i >= 0) {
    state.compare.splice(i, 1);
  } else {
    if (state.compare.length >= MAX_COMPARE) {
      toast(`最多同时对比 ${MAX_COMPARE} 款，先取消一个`);
      return;
    }
    state.compare.push(id);
  }
  syncCompareUI();
}

function clearCompare() {
  state.compare = [];
  syncCompareUI();
}

/** 同步所有和对比有关的外观：产品带上的按钮 + 底部对比栏 */
function syncCompareUI() {
  for (const btn of $$('[data-compare]')) {
    const on = isComparing(btn.dataset.compare);
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('is-on', on);
    btn.textContent = on ? '已加入' : '＋ 对比';
  }

  const bar = $('#comparebar');
  if (!bar) return;

  const picked = compareProducts();
  bar.hidden = picked.length === 0;
  document.body.classList.toggle('has-comparebar', picked.length > 0);

  const slots = $('[data-cb-slots]', bar);
  slots.textContent = '';
  for (const p of picked) {
    const chip = document.createElement('span');
    chip.className = 'cb-chip';
    chip.innerHTML = `<span class="cb-chip-name">${esc(titleOf(p))}</span>`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'cb-chip-x';
    x.setAttribute('aria-label', `移除 ${titleOf(p)}`);
    x.textContent = '×';
    x.addEventListener('click', () => toggleCompare(p.id));
    chip.appendChild(x);
    slots.appendChild(chip);
  }

  $('[data-cb-go]', bar).disabled = picked.length < 2;
  const hint = $('[data-cb-hint]', bar);
  if (hint) {
    hint.textContent = picked.length < 2
      ? '再选一款就能对比'
      : `已选 ${picked.length} 款`;
  }

  /* 底部留白按对比栏的实测高度来设，而不是写死一个值 ——
     窄屏上对比栏会折行变高，写死就会盖住页脚。 */
  requestAnimationFrame(() => {
    if (bar.hidden) {
      document.body.style.removeProperty('padding-bottom');
    } else {
      document.body.style.paddingBottom = Math.ceil(bar.getBoundingClientRect().height) + 'px';
    }
  });
}

/** 生成对比表：参数为行、机型为列，差异项高亮 */
function buildCompareTable(picked) {
  const cats = [...new Set(picked.map((p) => p.category))];
  const multiCat = cats.length > 1;

  const keys = [];
  const labelOf = {};
  for (const p of picked) {
    for (const f of specFields(p.category)) {
      if (!(f.key in labelOf)) { labelOf[f.key] = f.label; keys.push(f.key); }
    }
  }

  const cell = (p, key) => {
    const has = specFields(p.category).some((f) => f.key === key);
    if (!has) return { text: '', na: true };
    const v = p.specs ? p.specs[key] : undefined;
    /* 表格里的空值占位符，不是文案里的破折号 */
    return { text: (v === undefined || v === null || v === '') ? '—' : String(v), na: false }; /* taste-skill-ignore */
  };

  const rows = keys.map((key) => {
    const cells = picked.map((p) => cell(p, key));
    const vals = cells.filter((c) => !c.na).map((c) => c.text);
    const same = vals.length > 0 && vals.every((v) => v === vals[0]);
    return { key, label: labelOf[key], cells, same };
  });

  /* 价格行：差价到 5% 才值得高亮，否则等于没有重点 */
  const prices = picked.map((p) => p.price);
  const maxP = Math.max(...prices);
  const minP = Math.min(...prices);
  const priceDiff = maxP - minP;
  const priceWorthHighlight = priceDiff >= 100 && (priceDiff / minP) >= 0.05;

  const th = picked.map((p) => `
      <th scope="col">
        <a class="cmp-name" href="${esc(hrefOf(p))}">${esc(titleOf(p))}</a>
        <span class="cmp-brand">${esc(p.brand)}</span>
      </th>`).join('');

  const priceRow = `
      <tr class="cmp-row cmp-row--price${priceWorthHighlight ? ' is-diff' : ''}">
        <th scope="row">参考价</th>
        ${picked.map((p) => `<td><span class="cmp-price">¥${esc(money(p.price))}</span></td>`).join('')}
      </tr>`;

  const fitRow = `
      <tr class="cmp-row">
        <th scope="row">对上你的预算</th>
        ${picked.map((p) => {
          const f = priceFit(p.price, state.budget);
          return `<td class="${f.cls}">${esc(f.text)}</td>`;
        }).join('')}
      </tr>`;

  const specRowsHtml = rows.map((r) => `
      <tr class="cmp-row${r.same ? '' : ' is-diff'}">
        <th scope="row">${esc(r.label)}</th>
        ${r.cells.map((c) => c.na
          ? '<td class="cmp-na">不适用</td>'
          : `<td>${esc(c.text)}</td>`).join('')}
      </tr>`).join('');

  const diffCount = rows.filter((r) => !r.same).length + (priceWorthHighlight ? 1 : 0);

  return { html: `
    <table class="cmptable">
      <thead>
        <tr><th scope="col" class="cmp-corner">对比项</th>${th}</tr>
      </thead>
      <tbody>
        ${priceRow}
        ${fitRow}
        ${specRowsHtml}
      </tbody>
    </table>
    <p class="cmp-note">
      ${rows.length} 项参数，<b>${diffCount}</b> 项有差异（已高亮）。
      ${multiCat ? '跨品类对比时，不适用的参数显示为「不适用」。' : ''}
    </p>`,
  };
}

function openCompare() {
  const picked = compareProducts();
  if (picked.length < 2) return;

  const dlg = $('#cmpdlg');
  if (!dlg) return;

  const { html } = buildCompareTable(picked);
  $('#cmp-body').innerHTML = html;
  $('#cmp-title').textContent = picked.map((p) => titleOf(p)).join('  vs  ');

  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

/* ============================================================
 * 全站搜索：导航里的那个动作
 * ============================================================ */

function searchMatches(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return PRODUCTS.filter((p) => {
    const haystack = [p.name, p.brand, categoryName(p.category), ...(p.tags || [])]
      .join(' ').toLowerCase();
    return haystack.includes(needle);
  }).slice(0, SEARCH_LIMIT);
}

/* 型号库索引（9 千多条名字）：第一次打开搜索时才拉，避免每个页面都背着它 */
let modelIndex = null;
let modelIndexPromise = null;

function ensureModelIndex() {
  if (modelIndex) return Promise.resolve(modelIndex);
  if (modelIndexPromise) return modelIndexPromise;
  modelIndexPromise = fetch('/models.json?ts=' + Date.now(), { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      modelIndex = data && Array.isArray(data.items) ? data : { items: [] };
      return modelIndex;
    })
    .catch(() => {
      modelIndex = { items: [] };
      return modelIndex;
    });
  return modelIndexPromise;
}

function modelMatches(q, limit = 6) {
  if (!modelIndex || !Array.isArray(modelIndex.items)) return [];
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  /* 拉丁查询按词边界匹配：iphone 不该命中 MultiPhone */
  const latin = !/[\u4e00-\u9fa5]/.test(needle);
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = latin ? new RegExp('(^|[^a-z0-9])' + esc + '(?=$|[^a-z0-9])', 'i') : null;
  return modelIndex.items
    .filter((it) => {
      const name = String(it[0] || '');
      return re ? re.test(name) : name.toLowerCase().includes(needle);
    })
    .slice(0, limit);
}

function initSearch() {
  const dlg = $('#searchdlg');
  if (!dlg) return;

  const input = $('#search-input');
  const results = $('[data-search-results]');
  const foot = $('[data-search-foot]');

  const renderResults = () => {
    const q = input.value;
    const hits = searchMatches(q);
    /* 型号库里、产品页里没有的名字（避免重复） */
    const seenNames = new Set(hits.map((p) => titleOf(p)));
    const seenLinks = new Set(hits.map((p) => hrefOf(p)));
    const extra = modelMatches(q).filter(([name, , href]) =>
      !seenNames.has(name) && (!href || !seenLinks.has(href)));

    results.textContent = '';
    if (!q.trim()) {
      results.innerHTML = '<p class="search-empty">输入型号、品牌或卖点。</p>';
    } else if (!hits.length && !extra.length) {
      results.innerHTML = `<p class="search-empty">没有找到“${esc(q.trim())}”，试试更短的词。</p>`;
    } else {
      for (const p of hits) {
        const a = document.createElement('a');
        a.className = 'sresult';
        a.href = hrefOf(p);
        const meta = subName(p.category, p.sub) || categoryName(p.category);
        a.innerHTML =
          `<span class="s-name">${esc(titleOf(p))}</span>` +
          `<span class="s-meta">${esc(meta)}，¥${esc(money(p.price))}</span>`;
        results.appendChild(a);
      }
      for (const [name, cat, href] of extra) {
        const a = document.createElement('a');
        a.className = 'sresult';
        a.href = href || `/models/${cat}/`;
        a.innerHTML =
          `<span class="s-name">${esc(name)}</span>` +
          `<span class="s-meta">型号库${href ? '' : '，参数待补'}</span>`;
        results.appendChild(a);
      }
    }

    if (foot) {
      foot.innerHTML = q.trim()
        ? `<a class="link" href="/?q=${encodeURIComponent(q.trim())}#board">在选数码里查看全部结果</a>`
        : `回车打开第一条结果，<kbd>Esc</kbd> 关闭`;
    }
  };

  const open = (q = '') => {
    input.value = q;
    renderResults();
    /* 后台补上型号库索引，加载完再刷新一次结果 */
    ensureModelIndex().then(() => { if (dlg.open) renderResults(); });
    if (typeof dlg.showModal === 'function') {
      if (!dlg.open) dlg.showModal();
    } else {
      dlg.setAttribute('open', '');
    }
    input.focus();
    input.select();
  };

  const close = () => {
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  };

  for (const btn of $$('[data-open-search]')) {
    btn.addEventListener('click', () => open());
  }

  input.addEventListener('input', renderResults);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('.sresult', results);
      if (first) {
        e.preventDefault();
        location.href = first.href;
      } else if (input.value.trim()) {
        e.preventDefault();
        location.href = `/?q=${encodeURIComponent(input.value.trim())}#board`;
      }
    }
  });

  $('[data-search-close]')?.addEventListener('click', close);

  /* 全局快捷键：/ 或 Ctrl/Cmd + K */
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
      e.preventDefault();
      open();
    }
  });

  /* 首页带 ?q= 进来：交给 boot 读取，这里只处理关闭后的焦点 */
  dlg.addEventListener('close', () => {
    document.activeElement?.blur?.();
  });
}

/* ============================================================
 * 顶栏：移动端菜单 + 段落入场
 * ============================================================ */

function initNav() {
  const toggle = $('.nav-toggle');
  const menu = $('#nav-menu');
  if (!toggle || !menu) return;

  const setOpen = (open) => {
    menu.dataset.open = String(open);
    toggle.setAttribute('aria-expanded', String(open));
  };

  toggle.addEventListener('click', () => setOpen(menu.dataset.open !== 'true'));
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.dataset.open === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
}

/* 首页的导航当前态跟着 #board 走：
   点「选数码」跳到产品板后，高亮应该落在「选数码」而不是「首页」。 */
function initNavActive() {
  if (!$('[data-board-list]')) return;   /* 只在首页生效，内页有自己的当前项 */
  const home = $('.nav-link[data-nav="home"]');
  const board = $('.nav-link[data-nav="board"]');
  if (!home || !board) return;

  const sync = () => {
    const onBoard = location.hash === '#board';
    if (onBoard) {
      home.removeAttribute('aria-current');
      board.setAttribute('aria-current', 'page');
    } else {
      board.removeAttribute('aria-current');
      home.setAttribute('aria-current', 'page');
    }
  };

  window.addEventListener('hashchange', sync);
  sync();
}

function initReveal() {
  const els = $$('[data-reveal]');
  if (!els.length) return;

  if (!('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      en.target.classList.add('is-in');
      io.unobserve(en.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: .05 });

  els.forEach((el) => io.observe(el));
}

/* ---------- 详情页 ----------
 * 详情页正文全是构建时写死的静态 HTML，
 * 这里只干一件事：有推广链接时把购买入口填进去。 */
function initDetailPage(article) {
  const id = article.dataset.productId;
  const cta = $('#cta');
  if (!id || !cta) return;

  const product = PRODUCTS.find((p) => p.id === id);
  if (!product) return;

  getPrice(product).then((info) => {
    if (!info || !info.buyUrl) return;

    const a = document.createElement('a');
    a.className = 'btn btn-accent';
    a.href = info.buyUrl;
    a.target = '_blank';
    a.rel = 'nofollow sponsored noopener';
    a.textContent = '去看看当前价格';

    const hint = document.createElement('span');
    hint.className = 'cta-hint';
    hint.textContent = '跳到电商页面查看实时价格';

    cta.append(a, hint);
    cta.hidden = false;
  });
}

/* ---------- 产品页的「预算对照」小控制台 ----------
 * 这是产品在页面上工作：滑杆一动，就告诉你这款在你的预算里是什么处境。 */
function initProductConsole() {
  const inputs = $$('[data-product-price]');
  if (!inputs.length) return;

  const render = (input) => {
    const box = input.closest('.console');
    if (!box) return;
    const price = Number(input.dataset.productPrice);
    const budget = Number(input.value);
    const fit = priceFit(price, budget);

    const out = $('[data-budget-value]', box);
    if (out) out.innerHTML = `<span class="rmb">¥</span>${esc(money(budget))}`;

    const fill = $('[data-budget-fill]', box);
    if (fill) {
      const min = Number(input.min);
      const max = Number(input.max);
      const pct = max > min ? ((budget - min) / (max - min)) * 100 : 0;
      fill.style.width = Math.min(100, Math.max(0, pct)).toFixed(2) + '%';
    }

    const line = $('[data-product-fit]', box);
    if (line) {
      let text;
      if (fit.cls === 'band-fit--over') text = `这款 ¥${money(price)}，超预算 ¥${money(price - budget)}`;
      else if (fit.cls === 'band-fit--best') text = `这款 ¥${money(price)}，刚好卡住预算`;
      else text = `这款 ¥${money(price)}，在预算内，还余 ¥${money(budget - price)}`;
      line.textContent = text;
      line.className = 'console-fit ' + fit.cls;
    }
  };

  for (const input of inputs) {
    input.addEventListener('input', () => render(input));
    render(input);
  }
}

/* ---------- 轻提示 ---------- */
let toastTimer = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2200);
}

/* ---------- 启动 ---------- */
function boot() {
  const fail = (msg) => {
    const el = document.getElementById('jserr');
    if (el) {
      el.hidden = false;
      el.textContent = '运行失败：' + msg;
    }
  };

  initNav();
  initNavActive();
  initSearch();
  initReveal();

  if (typeof PRODUCTS === 'undefined' || !Array.isArray(PRODUCTS)) {
    fail('data.js 没有加载成功（请确认它在 app.js 之前引入，且文件在同一目录）');
    const list = $('[data-board-list]');
    if (list) list.innerHTML = '<p class="loading">参数库未加载。</p>';
    return;
  }

  try {
    renderTicker();
    renderSiteIndex();
    initHeroField();
    initSparks();

    /* 详情页：只填购买入口 */
    const article = document.querySelector('.pdetail[data-product-id]');
    const isBoard = !!$('[data-board-list]');
    if (article && !isBoard) {
      initDetailPage(article);
      initProductConsole();
      return;
    }

    /* 首页：完整初始化（预算、品类、排序、搜索词都可以从 URL 带进来） */
    readUrlState();

    const countEl = $('[data-board-count]');
    countEl?.addEventListener('click', (e) => {
      if (!e.target.closest('[data-clear-query]')) return;
      e.preventDefault();
      state.query = '';
      syncUrl();
      renderBoard();
    });

    initBudgetControls();
    renderTabs();
    renderSubTabs();
    renderSort();
    renderBoard();

    /* 对比栏 & 弹窗 */
    const dlg = $('#cmpdlg');
    $('[data-cb-go]')?.addEventListener('click', openCompare);
    $('[data-cb-clear]')?.addEventListener('click', clearCompare);
    $('[data-cmp-close]')?.addEventListener('click', () => dlg?.close());
    $('[data-cmp-close2]')?.addEventListener('click', () => dlg?.close());
    dlg?.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    syncCompareUI();

    /* 视口变化时对比栏可能折行（高度变了），重新量一次底部留白 */
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(syncCompareUI, 120);
    });

    console.log(
      `[digivue] 已载入 ${PRODUCTS.length} 款演示产品 · 价格为样例数据，非实时报价`
    );
  } catch (err) {
    console.error('[digivue] 初始化失败：', err);
    fail((err && err.message) || String(err));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
