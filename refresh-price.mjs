#!/usr/bin/env node
/* ============================================================
 * 价格刷新 —— 第一层（定时全量）
 * ------------------------------------------------------------
 * 把每款产品的价格刷新一遍，写进 prices.json；
 * build.mjs 构建时读这个文件，把价格写进静态页面。
 *
 * 三个供应商（--provider）：
 *   snapshot  默认。不调任何接口，价格沿用参数库里的参考价（现在的状态）
 *   mock      测试用。凭空造一批价格，专门验证「取价 → 校验 → 合并」这条管线
 *   jd        京东联盟。真正接接口的那个，需要三个环境变量：
 *               JD_UNION_KEY      AppKey
 *               JD_UNION_SECRET   AppSecret
 *               JD_UNION_PID      推广位 ID（可选，但没有它拿不到佣金）
 *
 * 用法：
 *   node refresh-price.mjs                             # 快照刷新
 *   node refresh-price.mjs --provider mock --dry-run   # 先看管线会做什么
 *   node refresh-price.mjs --provider jd               # 真正联网取价
 *   node refresh-price.mjs --only phone                # 只刷某个大类
 *
 * ------------------------------------------------------------
 * 数据模型：型号 ↔ 渠道货
 * ------------------------------------------------------------
 * data.js 里的 product 是「型号」（参数、卖点、适合谁）；渠道的货挂在 offers 上：
 *
 *   offers: [{ platform: 'jd', sku: '100012345678', pid: '你的推广位' }]
 *
 * 同一型号在京东、淘宝是不同的 SKU，价格跟着 SKU 走。一款产品有多个 offer 时，
 * 本脚本取价格最低的那个当展示价，并把全部 offer 一起写进 prices.json。
 * 没有绑定 offer 的产品沿用参数库参考价，note 里写明原因。
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { loadEnv } from './env.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
loadEnv(ROOT);

const PRICES_FILE = join(ROOT, 'prices.json');

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const DRY_RUN = Boolean(flag('dry-run', false));
const ONLY = flag('only', null);
const PROVIDER_ID = String(flag('provider', 'snapshot'));

/* ============================================================
 * 小工具
 * ============================================================ */

const PLATFORM_LABEL = { jd: '京东联盟', tb: '淘宝客', pdd: '多多进宝', mock: '模拟' };

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/** 本地时间戳，够用就行 */
function nowISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ============================================================
 * 供应商
 * ------------------------------------------------------------
 * 统一契约：fetchPrices(products) → 每条 offer 一个结果
 *   { id, platform, sku, price, commissionRate, buyUrl, ok, note }
 * 没有绑定 offer 的产品不需要返回 —— 合并阶段会给它们沿用参考价。
 * ============================================================ */

/** 快照：不联网，价格沿用参数库里的参考价 */
const SNAPSHOT_PROVIDER = {
  id: 'snapshot',
  label: '快照（未接真实接口）',
  async fetchPrices() {
    return [];
  },
};

/**
 * 模拟：只用来验证管线。
 * 造一批带小波动的价格，走完「取价 → 校验 → 合并 → 写文件」全流程。
 * 它绝不联网，note 里也写明了是模拟数据 —— 别拿它当真实价格。
 */
const MOCK_PROVIDER = {
  id: 'mock',
  label: '模拟（仅用于测试管线）',
  async fetchPrices(products) {
    const out = [];
    for (const p of products) {
      const offers = (p.offers || []).filter((o) => o && o.sku);
      /* 绑了渠道的，就按渠道 SKU 造一条；没绑的造一条 mock，方便看整表效果 */
      if (offers.length) {
        for (const o of offers) {
          out.push({
            id: p.id,
            platform: o.platform,
            sku: o.sku,
            price: Math.round(p.price * (0.96 + Math.random() * 0.07)),
            commissionRate: p.commissionRate ?? 0,
            buyUrl: null,
            ok: true,
            note: '模拟数据（未调用任何接口）',
          });
        }
      } else {
        out.push({
          id: p.id,
          platform: 'mock',
          sku: 'mock-' + p.id,
          price: Math.round(p.price * (0.96 + Math.random() * 0.07)),
          commissionRate: p.commissionRate ?? 0,
          buyUrl: null,
          ok: true,
          note: '模拟数据（未调用任何接口）',
        });
      }
    }
    return out;
  },
};

/* ------------------------------------------------------------
 * 京东联盟
 * ------------------------------------------------------------
 * 关键约束（来自联盟协议）：
 *   1. 批量查询，别一个一个查
 *   2. 结果是「当前价」，不是你的价格库，别长期缓存
 *   3. 必须带推广位 pid，否则拿不到佣金
 *   4. AppKey 只从环境变量读，永远不要写进仓库
 *
 * ⚠️ 第一次跑请加 --dry-run：
 *    接口字段名（priceInfo / couponInfo / materialUrl 等）以官方文档为准。
 *    这份实现按标准的 jd.union.open.goods.query 结构写；对不上时会把原始
 *    返回打出来，照着改映射即可。
 * ------------------------------------------------------------ */

/** 京东开放平台签名：md5(secret + 排序后的 k1v1k2v2… + secret)，输出大写 */
function jdSign(params, secret) {
  const raw = Object.keys(params).sort().map((k) => k + String(params[k])).join('');
  return createHash('md5').update(secret + raw + secret, 'utf8').digest('hex').toUpperCase();
}

/** 京东要北京时间：2026-10-15 23:17:00 */
function jdTimestamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 从京东的返回里挖出商品数组（不同接口层级不一，尽量容错） */
function jdExtractList(payload) {
  const resp = payload && (payload.jd_union_open_goods_query_response
    || payload.jd_union_open_goods_query_responce
    || payload.jd_union_open_goods_query_response_v2);
  if (!resp) return null;

  const raw = resp.result ?? resp.getResult ?? resp;
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return null; }
  }
  if (data && Array.isArray(data.data)) return data.data;
  if (Array.isArray(data)) return data;
  return null;
}

const JD_PROVIDER = {
  id: 'jd-union',
  label: '京东联盟',

  async fetchPrices(products) {
    const key = process.env.JD_UNION_KEY;
    const secret = process.env.JD_UNION_SECRET;
    const pid = process.env.JD_UNION_PID || '';

    if (!key || !secret) {
      throw new Error(
        '缺少环境变量 JD_UNION_KEY / JD_UNION_SECRET（推广位再补 JD_UNION_PID）。\n' +
        '   申请步骤见 README「接真实价格」。临时设置（PowerShell）：\n' +
        '     $env:JD_UNION_KEY="你的AppKey"\n' +
        '     $env:JD_UNION_SECRET="你的AppSecret"\n' +
        '     $env:JD_UNION_PID="你的推广位ID"'
      );
    }

    /* 只有绑定了京东 offer 的产品才需要查询 */
    const targets = products.filter((p) =>
      (p.offers || []).some((o) => o && o.platform === 'jd' && o.sku));

    if (!targets.length) {
      console.warn('   ⚠️  没有任何产品绑定京东 SKU（data.js 里的 offers），这次取不到新价格。');
      return [];
    }

    const out = [];
    for (const batch of chunk(targets, 40)) {
      const skuToProduct = new Map();
      for (const p of batch) {
        for (const o of (p.offers || [])) {
          if (o && o.platform === 'jd' && o.sku) skuToProduct.set(String(o.sku), p);
        }
      }

      const params = {
        method: 'jd.union.open.goods.query',
        app_key: key,
        sign_method: 'md5',
        timestamp: jdTimestamp(),
        format: 'json',
        v: '1.0',
        skuIds: [...skuToProduct.keys()].join(','),
      };
      if (pid) params.pid = pid;
      params.sign = jdSign(params, secret);

      const res = await fetch('https://api.jd.com/routerjson', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });
      if (!res.ok) throw new Error(`京东接口 HTTP ${res.status}`);

      const payload = await res.json();
      const list = jdExtractList(payload);

      if (!list) {
        console.error('   ⚠️  没解析出商品列表，原始返回的前 400 字符：');
        console.error('   ' + JSON.stringify(payload).slice(0, 400));
        throw new Error('京东返回结构和预期不一致，照着上面的原始返回改 jdExtractList() 的映射');
      }

      for (const item of list) {
        const sku = String(item.skuId ?? item.sku_id ?? '');
        const product = skuToProduct.get(sku);
        if (!product) continue;

        const info = item.priceInfo || item.price_info || {};
        const price = Number(info.price ?? info.lowestPrice ?? info.lowest_price);
        const commission = item.commissionInfo || item.commission_info || {};
        const rate = Number(commission.commissionShare ?? commission.commission_share ?? NaN);

        out.push({
          id: product.id,
          platform: 'jd',
          sku,
          price,
          commissionRate: Number.isFinite(rate) ? rate : (product.commissionRate ?? 0),
          /* 推广链接：优先接口返回的（带 pid），否则按 SKU 拼一个京东链接 */
          buyUrl: item.materialUrl || item.material_url
            || (pid ? `https://u.jd.com/${pid}` : null),
          ok: true,
          note: '京东联盟接口',
        });
      }
    }

    return out;
  },
};

const PROVIDERS = {
  snapshot: SNAPSHOT_PROVIDER,
  mock: MOCK_PROVIDER,
  jd: JD_PROVIDER,
};

/* ============================================================
 * 读取产品与现有价格表
 * ============================================================ */

function loadProducts() {
  const src = readFileSync(join(ROOT, 'data.js'), 'utf8');
  const sandbox = { console, window: null };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(src + '\n;globalThis.__OUT = { PRODUCTS };', sandbox);
  return sandbox.__OUT.PRODUCTS;
}

function loadPrices() {
  if (!existsSync(PRICES_FILE)) return { updatedAt: null, provider: null, prices: {} };
  try {
    return JSON.parse(readFileSync(PRICES_FILE, 'utf8'));
  } catch (e) {
    console.warn(`⚠️  prices.json 解析失败，将重建：${e.message}`);
    return { updatedAt: null, provider: null, prices: {} };
  }
}

/* ============================================================
 * 校验：拿到脏数据就整个中止，绝不用坏价格覆盖好价格
 * ============================================================ */

function validate(products, results) {
  const problems = [];
  const byId = new Map(products.map((p) => [p.id, p]));

  for (const r of results) {
    if (!r || !r.id) { problems.push('返回了没有 id 的记录'); continue; }
    const src = byId.get(r.id);
    if (!src) { problems.push(`${r.id}：不在本次刷新范围内`); continue; }

    if (typeof r.price !== 'number' || !Number.isFinite(r.price) || r.price <= 0) {
      problems.push(`${r.id}（${r.platform}/${r.sku}）：价格异常（${JSON.stringify(r.price)}）`);
      continue;
    }
    /* 偏离参考价 4 倍以上，几乎一定是接口出错或字段读错了 */
    if (r.ok && Math.abs(r.price - src.price) / src.price > 4) {
      problems.push(`${r.id}：价格突变 ${src.price} → ${r.price}（偏离过大，疑似接口异常）`);
    }
    if (!PLATFORM_LABEL[r.platform]) {
      problems.push(`${r.id}：未知平台 "${r.platform}"`);
    }
  }
  return problems;
}

/* ============================================================
 * 合并：多 offer 取最低价当展示价，全部 offer 一起存下来
 * ============================================================ */

function merge(products, results, store) {
  const now = nowISO();
  const next = { ...store.prices };
  const stats = { withOffer: 0, noOffer: 0, changed: 0 };

  for (const p of products) {
    const prev = next[p.id] || {};
    const mine = results.filter((r) => r && r.id === p.id && r.ok !== false);

    if (!mine.length) {
      next[p.id] = {
        price: p.price,
        commissionRate: p.commissionRate ?? 0,
        buyUrl: prev.buyUrl ?? null,
        ok: true,
        platform: null,
        offers: [],
        refreshedAt: now,
        note: '未绑定渠道 SKU，沿用参数库参考价',
      };
      stats.noOffer++;
      continue;
    }

    const best = mine.slice().sort((a, b) => a.price - b.price)[0];
    if (prev.price !== best.price) stats.changed++;

    next[p.id] = {
      price: best.price,
      commissionRate: best.commissionRate ?? p.commissionRate ?? 0,
      buyUrl: best.buyUrl ?? null,
      ok: true,
      platform: best.platform,
      offers: mine.map((r) => ({
        platform: r.platform,
        sku: r.sku,
        price: r.price,
        buyUrl: r.buyUrl ?? null,
        note: r.note || '',
      })),
      refreshedAt: now,
      note: best.note || '',
    };
    stats.withOffer++;
  }

  return { next, stats };
}

/* ============================================================
 * 主流程
 * ============================================================ */

async function main() {
  const provider = PROVIDERS[PROVIDER_ID];
  if (!provider) {
    console.error(`❌ 不认识的 --provider "${PROVIDER_ID}"，可选：${Object.keys(PROVIDERS).join(' / ')}`);
    process.exit(1);
  }

  const all = loadProducts();
  const products = ONLY ? all.filter((p) => p.category === ONLY) : all;

  if (ONLY && products.length === 0) {
    console.error(`❌ --only ${ONLY} 没有匹配到任何产品。`);
    console.error(`   可用大类：${[...new Set(all.map((p) => p.category))].join(', ')}`);
    process.exit(1);
  }

  const bound = products.filter((p) => (p.offers || []).length).length;

  console.log(`\n🔄 价格刷新：${provider.label}`);
  console.log(`   待刷产品：${products.length} 款${ONLY ? `（仅 ${ONLY}）` : ''}`);
  console.log(`   已绑定渠道 SKU：${bound} 款，其余沿用参数库参考价\n`);

  let results;
  const started = Date.now();
  try {
    results = await provider.fetchPrices(products);
  } catch (err) {
    console.error(`❌ 取价失败：${err.message}`);
    console.error('   价格未做任何改动，prices.json 保持原样。');
    process.exit(1);
  }

  const problems = validate(products, results);
  if (problems.length) {
    console.error(`❌ 校验未通过，共 ${problems.length} 个问题，已中止：`);
    for (const p of problems.slice(0, 15)) console.error('   - ' + p);
    if (problems.length > 15) console.error(`   …还有 ${problems.length - 15} 个`);
    console.error('\n   prices.json 未被修改。');
    process.exit(1);
  }

  const store = loadPrices();
  const { next, stats } = merge(products, results, store);

  const out = {
    updatedAt: nowISO(),
    provider: provider.id,
    providerLabel: provider.label,
    count: Object.keys(next).length,
    prices: next,
  };

  console.log(`   取到价格：${results.length} 条（${Date.now() - started} ms）`);
  console.log(`   有渠道价：${stats.withOffer} 款 · 用参考价：${stats.noOffer} 款 · 价格有变化：${stats.changed} 款`);
  if (provider.id === 'jd-union') {
    const withLink = results.filter((r) => r.buyUrl).length;
    console.log(`   带推广链接：${withLink} 条${withLink ? '' : '（缺 JD_UNION_PID 或者接口没返回链接）'}`);
  }

  if (DRY_RUN) {
    console.log('\n   --dry-run：未写入 prices.json');
    for (const r of results.slice(0, 3)) {
      console.log(`     样例：${r.id} → ¥${r.price}（${r.platform}/${r.sku}）`);
    }
    return;
  }

  if (provider.id === 'mock') {
    console.warn('\n   ⚠️  这是模拟数据，只用来验证管线。写完 prices.json 后，');
    console.warn('      页面页脚会显示「模拟（仅用于测试管线）」。恢复真实参考价：');
    console.warn('      node refresh-price.mjs && node build.mjs');
  }

  writeFileSync(PRICES_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n✅ 已写入 prices.json（更新于 ${out.updatedAt}）`);
  console.log('   下一步：node build.mjs  把新价格写进静态页面\n');
}

main().catch((err) => {
  console.error('❌ 未预期的错误：', err);
  process.exit(1);
});
