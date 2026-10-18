/* ============================================================
 * 边缘函数模板：GET /api/price?id=<产品ID>
 * ------------------------------------------------------------
 * 这是「第二层价格」：用户打开产品页时按需取一次当前价。
 * 第一层（每天全量刷新 → 写进静态页）在 refresh-price.mjs 里，两层配合使用。
 *
 * 部署方式（EdgeOne Pages）：
 *   1. 在 Pages 项目的函数目录里放这个文件（EdgeOne 用 functions/ 目录做路由，
 *      具体约定以官方文档为准；这份按 onRequest 风格写，对应 /api/price）
 *   2. 项目设置里配环境变量：JD_UNION_KEY / JD_UNION_SECRET / JD_UNION_PID
 *   3. 部署后先把 data.js 里的 PRICE_API 改成 '/api/price'，再重新构建上传
 *
 * 它做三件事：
 *   ① 读同域的 /offers.json —— 型号 → 渠道 SKU 的映射，构建时生成，不含任何密钥
 *   ② 用环境变量里的 AppKey 去调京东联盟
 *   ③ 结果缓存 15 分钟：联盟协议禁止长期缓存价格，别把 TTL 调大
 *
 * ⚠️ 模板说明：
 *   京东的 md5 签名需要 crypto。Node 运行时直接可用（下面就是这么写的）；
 *   如果你的运行时没有 node:crypto，把 md5() 换成一份纯 JS 实现即可。
 *   接口字段名（priceInfo / materialUrl 等）以官方文档为准。
 * ============================================================ */

import { createHash } from 'node:crypto';

const CACHE_TTL = 15 * 60;          /* 秒。价格缓存上限，别调大 */
const JD_ENDPOINT = 'https://api.jd.com/routerjson';

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex').toUpperCase();

/** 京东签名：md5(secret + 排序后的 k1v1k2v2… + secret) */
function jdSign(params, secret) {
  const raw = Object.keys(params).sort().map((k) => k + String(params[k])).join('');
  return md5(secret + raw + secret);
}

function jdTimestamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');   /* taste-skill-ignore：时间戳补零，不是 01/02 序号 */
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_TTL}`,
    },
  });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ ok: false, error: '缺少 id 参数' }, 400);

  const key = env.JD_UNION_KEY;
  const secret = env.JD_UNION_SECRET;
  const pid = env.JD_UNION_PID || '';
  if (!key || !secret) return json({ ok: false, error: '服务端未配置京东联盟密钥' }, 500);

  try {
    /* ① 型号 → SKU（同域静态文件，构建时生成） */
    const mapping = await fetch(new URL('/offers.json', url.origin)).then((r) => r.json());
    const offers = (mapping.products && mapping.products[id]) || [];
    const jdOffers = offers.filter((o) => o && o.platform === 'jd' && o.sku);
    if (!jdOffers.length) {
      return json({ ok: false, error: '这款还没绑定京东 SKU' }, 404);
    }

    const sku = jdOffers[0].sku;

    /* ② 有 KV 就先读缓存（键按 SKU，TTL 15 分钟） */
    const cacheKey = 'price:jd:' + sku;
    if (env.PRICE_CACHE && typeof env.PRICE_CACHE.get === 'function') {
      const hit = await env.PRICE_CACHE.get(cacheKey, 'json');
      if (hit) return json({ ...hit, cached: true });
    }

    /* ③ 调京东联盟 */
    const params = {
      method: 'jd.union.open.goods.query',
      app_key: key,
      sign_method: 'md5',
      timestamp: jdTimestamp(),
      format: 'json',
      v: '1.0',
      skuIds: String(sku),
    };
    if (pid) params.pid = pid;
    params.sign = jdSign(params, secret);

    const res = await fetch(JD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    if (!res.ok) return json({ ok: false, error: '京东接口 HTTP ' + res.status }, 502);

    const payload = await res.json();
    const raw = payload.jd_union_open_goods_query_response?.result;
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const item = data && Array.isArray(data.data) ? data.data[0] : null;
    if (!item) return json({ ok: false, error: '接口没有返回这件商品' }, 404);

    const info = item.priceInfo || {};
    const out = {
      ok: true,
      source: 'jd-union',
      price: Number(info.price ?? info.lowestPrice),
      commissionRate: Number(item.commissionInfo?.commissionShare ?? 0),
      buyUrl: item.materialUrl || null,
      note: '京东联盟实时价',
      updatedAt: new Date().toISOString(),
    };
    if (!Number.isFinite(out.price) || out.price <= 0) {
      return json({ ok: false, error: '价格字段解析失败' }, 502);
    }

    if (env.PRICE_CACHE && typeof env.PRICE_CACHE.put === 'function') {
      await env.PRICE_CACHE.put(cacheKey, JSON.stringify(out), { expirationTtl: CACHE_TTL });
    }
    return json(out);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
}
