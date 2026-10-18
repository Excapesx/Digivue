#!/usr/bin/env node
/* ============================================================
 * 型号发现（catalog discovery）
 * ------------------------------------------------------------
 * 解决「产品太少」的第一步：不是手写，而是先让机器把市面上的型号捞出来。
 *
 * 数据来源（合法通道）：
 *   jd    京东联盟商品搜索 jd.union.open.goods.query —— 官方推广接口，
 *         返回商品名、SKU、价格、店铺，用来「发现型号」最合适
 *   mock  不联网，造一批带营销词/多规格/重复项的商品标题，
 *         用来验证「清洗 → 去重 → 聚合变体」这条管线
 *   wikidata  维基数据（CC0，免备案、免密钥）：直接拿设备型号名称，
 *         适合先要「名字」、参数以后再补的场景
 *
 * 它不抓网页、不碰图片文案，只拿商品标题里的型号事实。
 *
 * 用法：
 *   node discover.mjs --provider mock                       # 先看管线
 *   node discover.mjs --query "手机" --pages 2              # 京东联盟真接口
 *   node discover.mjs --query "微单" --category camera --pages 1
 *   node discover.mjs --provider wikidata --classes phone,laptop --limit 300
 *   node discover.mjs --fresh                               # 不合并旧结果，重新起一份
 *
 * 输出（都在 data/ 下）：
 *   candidates.json   机器用：聚合后的型号候选（含来源、SKU、价格）
 *   candidates.csv    人用：Excel 打开就能审核
 *
 * 需要环境变量：JD_UNION_KEY / JD_UNION_SECRET（JD_UNION_PID 可选）
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { loadEnv } from './env.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
loadEnv(ROOT);

const DATA_DIR = join(ROOT, 'data');
const OUT_JSON = join(DATA_DIR, 'candidates.json');
const OUT_CSV = join(DATA_DIR, 'candidates.csv');

/* ---------- 命令行 ---------- */
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const PROVIDER = String(flag('provider', 'jd'));
const QUERY = String(flag('query', '手机'));
const PAGES = Math.max(1, Number(flag('pages', 2)) || 2);
const CATEGORY_HINT = flag('category', null);
const FRESH = Boolean(flag('fresh', false));
const CLASSES = String(flag('classes', 'phone,laptop,tablet,camera,wearable,lens,peripheral,accessory'))
  .split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Math.max(1, Number(flag('limit', 200)) || 200);   /* 每个细分类最多取多少条 */

/* ============================================================
 * 标题清洗用的词表
 * ------------------------------------------------------------
 * 电商标题是「型号 + 卖点 + 规格 + 颜色 + 营销词」的拼接。
 * 下面三张表负责把型号之外的东西剥掉；不追求 100% 准确，
 * 剩下的交给 candidates.csv 人工过一眼。
 * ============================================================ */

/* 品牌：[规范名, 别名…]（别名按长度优先匹配） */
const BRANDS = [
  ['苹果', ['Apple', '苹果', '蘋果']],
  ['小米', ['Xiaomi', '小米']],
  ['Redmi', ['Redmi', '红米']],
  ['华为', ['HUAWEI', '华为', '華為']],
  ['荣耀', ['HONOR', '荣耀', '榮耀']],
  ['OPPO', ['OPPO']],
  ['vivo', ['vivo']],
  ['iQOO', ['iQOO']],
  ['一加', ['OnePlus', '一加']],
  ['三星', ['Samsung', '三星']],
  ['联想', ['Lenovo', '联想', '聯想']],
  ['华硕', ['ASUS', '华硕', '華碩']],
  ['戴尔', ['DELL', '戴尔', '戴爾']],
  ['惠普', ['HP', '惠普']],
  ['宏碁', ['Acer', '宏碁']],
  ['机械革命', ['机械革命']],
  ['微星', ['MSI', '微星']],
  ['索尼', ['Sony', '索尼']],
  ['索尼爱立信', ['Sony Ericsson', '索尼爱立信']],
  ['佳能', ['Canon', '佳能']],
  ['尼康', ['Nikon', '尼康']],
  ['富士', ['Fujifilm', '富士']],
  ['松下', ['Panasonic', '松下']],
  ['大疆', ['DJI', '大疆']],
  ['适马', ['Sigma', '适马']],
  ['腾龙', ['Tamron', '腾龙']],
  ['罗技', ['Logitech', '罗技']],
  ['雷蛇', ['Razer', '雷蛇']],
  ['Keychron', ['Keychron']],
  ['努比亚', ['努比亚', 'nubia']],
  ['绿联', ['绿联', 'UGREEN']],
  ['闪迪', ['闪迪', 'SanDisk']],
  ['Nothing', ['Nothing']],
  ['诺基亚', ['Nokia', '诺基亚', '諾基亞']],
  ['摩托罗拉', ['Motorola', '摩托罗拉']],
  ['中兴', ['ZTE', '中兴', '中興']],
  ['魅族', ['Meizu', '魅族']],
  ['黑鲨', ['Black Shark', '黑鲨']],
  ['真我', ['realme', '真我']],
  ['谷歌', ['Google', '谷歌']],
  ['Garmin', ['Garmin', '佳明']],
  ['Amazfit', ['Amazfit', '华米']],
  ['GoPro', ['GoPro']],
  ['影石', ['Insta360', '影石']],
  ['徕卡', ['Leica', '徕卡']],
  ['哈苏', ['Hasselblad', '哈苏']],
  ['雷神', ['ThundeRobot', '雷神']],
  ['神舟', ['Hasee', '神舟']],
  ['外星人', ['Alienware', '外星人']],
  ['微软', ['Microsoft', '微软', '微軟']],
];

/* 营销词 / 店铺词：直接删掉 */
const PROMO_WORDS = [
  '官方旗舰店', '京东自营', '旗舰店', '官方', '自营', '国行', '全新', '正品', '现货',
  '秒杀', '百亿补贴', '政府补贴', '以旧换新', '分期免息', '学生价', '限时', '新品',
  '首发', '套装', '礼盒', '赠品', '晒单', '包邮', '券后', '直降', '补贴价', '正式开售',
  '套机', '单机身', '标准套装', '全能套装', '畅拍',
];

/* 标题里没写品牌名时，靠产品线反推（只在完全找不到品牌时用） */
const FALLBACK_BRANDS = [
  ['苹果', ['iPhone', 'iPad', 'MacBook', 'Mac mini', 'AirPods', 'Apple Watch']],
  ['联想', ['ThinkBook', 'ThinkPad', '小新', '拯救者', 'Legion', 'Yoga']],
  ['三星', ['Galaxy']],
  ['谷歌', ['Pixel', 'Google']],
  ['微软', ['Surface']],
  ['索尼', ['Xperia']],
  ['谷歌', ['Nexus']],
];

/* 规范中文名 → 常见拉丁写法（用来去掉型号开头重复的品牌词，如 Google Pixel 9） */
const BRAND_LATIN = {
  苹果: 'Apple', 小米: 'Xiaomi', Redmi: 'Redmi', 华为: 'HUAWEI', 荣耀: 'HONOR',
  OPPO: 'OPPO', vivo: 'vivo', iQOO: 'iQOO', 一加: 'OnePlus', 三星: 'Samsung',
  联想: 'Lenovo', 华硕: 'ASUS', 戴尔: 'DELL', 惠普: 'HP', 宏碁: 'Acer',
  机械革命: 'MECHREVO', 微星: 'MSI', 索尼: 'Sony', 佳能: 'Canon', 尼康: 'Nikon',
  富士: 'Fujifilm', 松下: 'Panasonic', 大疆: 'DJI', 适马: 'Sigma', 腾龙: 'Tamron',
  罗技: 'Logitech', 雷蛇: 'Razer', Keychron: 'Keychron', 努比亚: 'nubia',
  绿联: 'UGREEN', 闪迪: 'SanDisk', Nothing: 'Nothing', 谷歌: 'Google',
};

/* 型号后面出现这些词，就说明型号已经结束 */
const STOP_WORDS = [
  /* 规格 */
  'GB', 'TB', 'g', '内存', '存储', '运行内存', '机身内存',
  /* 颜色 */
  '黑', '白', '蓝', '绿', '紫', '金', '银', '灰', '钛', '粉', '橙', '青', '红',
  '原色', '雪岩', '曜石', '旷野', '青云', '远峰',
  /* 品类词 */
  '手机', '平板', '笔记本', '台式机', '显示器', '耳机', '音箱', '相机', '镜头',
  '卡片机', '数码相机',
  '手表', '手环', '眼镜', '键盘', '鼠标', '充电器', '移动电源', 'U盘', '硬盘',
  /* 卖点词 */
  '徕卡', '蔡司', '哈苏', '光学', '影像', '长焦', '广角', '微距', '骁龙', '天玑',
  '麒麟', '酷睿', '锐龙', '旗舰', '高刷', '护眼', '双摄', '三摄', '四摄', '快充',
  '闪充', '续航', '轻薄', '游戏本', '轻薄本', '性能本', '办公', '机械键盘',
  '矮轴', '降噪', '蓝牙', '无线', '有线', '全网通', '5G', '4G', 'WIFI', 'WLAN',
  '国补', '双十一', '618', '学生', '商务', '电竞',
  '全画幅', '半画幅', '版', '卡口',
  'Headphones', 'Headset', 'Noise-Canceling', 'Noise Cancelling',
];

/* 出现在型号后面、以这些词开头的 token 一定是卖点，不是型号 */
const FEATURE_PREFIXES = [
  '锐龙', '酷睿', '骁龙', '天玑', '麒麟', '徕卡', '蔡司', '哈苏',
  '全画幅', '光学', '影像', '高刷', '护眼', '快充', '游戏', '电竞', '旗舰',
];

/* 从标题猜我们站内的大类，方便分拣 */
const CATEGORY_GUESS = [
  ['lens', ['镜头', '卡口', '变焦', '定焦', 'mm F']],
  ['camera', ['相机', '微单', '单反', '拍立得', '运动相机', '摄像机', '卡片机', '数码相机']],
  ['phone', ['手机', '5G', '4G', '折叠屏']],
  ['tablet', ['平板', 'iPad', 'MatePad', 'Pad']],
  ['laptop', ['笔记本', 'MacBook', '轻薄本', '游戏本', '创作本', '二合一',
              'ThinkBook', 'ThinkPad', '拯救者', 'Yoga', 'Legion']],
  ['desktop', ['台式机', '主机', 'Mac mini', '迷你主机', '整机']],
  ['wearable', ['手表', '手环', '智能眼镜', 'Watch', 'Band']],
  ['peripheral', ['显示器', '键盘', '鼠标', '扩展坞', '键鼠']],
  ['accessory', ['充电器', '移动电源', '耳机', '音箱', 'U盘', '硬盘', '充电宝', '数据线',
                 '闪存盘', '存储卡', '内存卡']],
];

/* ============================================================
 * 清洗与归并
 * ============================================================ */

const normText = (s) => String(s || '')
  .replace(/[\u3000]/g, ' ')
  .replace(/[【】\[\]（）()「」]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const compact = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[-_/]/g, '');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 在文本里找别名：拉丁字母要有词边界（避免 MultiPhone 命中 iPhone），中文直接包含 */
function findAlias(text, alias) {
  const lower = text.toLowerCase();
  const a = alias.toLowerCase();
  if (/[\u4e00-\u9fa5]/.test(alias)) return lower.indexOf(a);
  const re = new RegExp('(^|[^a-z0-9])' + escapeRe(a) + '(?=$|[^a-z0-9])', 'i');
  const m = re.exec(lower);
  return m ? m.index + m[1].length : -1;
}

/** 找标题里的品牌：出现位置最靠前的优先，同位置取更长的别名 */
function detectBrand(title) {
  let best = null;
  for (const [canon, aliases] of BRANDS) {
    for (const alias of aliases) {
      const i = findAlias(title, alias);
      if (i < 0) continue;
      if (!best || i < best.index || (i === best.index && alias.length > best.alias.length)) {
        best = { canon, alias, index: i };
      }
    }
  }
  if (best) return best;

  /* 没有品牌名时，靠产品线反推 */
  for (const [canon, lines] of FALLBACK_BRANDS) {
    for (const line of lines) {
      const i = findAlias(title, line);
      if (i >= 0) return { canon, alias: line, index: i, fallback: true };
    }
  }
  return null;
}

/** 判断一个 token 是否该截断型号
 *  catGuess === 'lens' 时保留 18-50mm 这种焦段；其他品类里 "46mm" 是尺寸，截断 */
function isStop(token, catGuess) {
  const t = token.toLowerCase();
  if (!t) return true;
  if (/\d+\s*(gb|tb)/i.test(t)) return true;          /* 16GB+512GB / 256GB */
  if (/^\d+(\.\d+)?mm$/i.test(t)) return catGuess !== 'lens';   /* 表壳 46mm 截断，镜头 50mm 保留 */
  if (/^\d+-\d+$/.test(t)) return catGuess !== 'lens';          /* 相机套机 16-50；镜头 18-50 保留 */
  if (/^(5g|4g)/i.test(t)) return true;
  if (/色$/.test(t)) return true;                      /* 午夜色 / 星光色 */
  if (/版$/.test(t)) return true;                      /* NFC版 / 素皮版 */
  if (FEATURE_PREFIXES.some((p) => t.startsWith(p))) return true;

  /* 带数字的 token 大概率还是型号（手环10、K80、16），只做精确匹配 */
  if (/\d/.test(t)) return STOP_WORDS.some((w) => t === w.toLowerCase());

  return STOP_WORDS.some((w) => {
    const wl = w.toLowerCase();
    return t === wl || (wl.length > 1 && t.includes(wl));
  });
}

/**
 * 从商品标题里抽「品牌 + 型号」。
 * 例：
 *   【政府补贴】小米 Xiaomi 15 徕卡光学 16GB+512GB 白色 5G手机
 *   → 小米 / 15
 *   Apple iPhone 16 Pro 256GB 原色钛金属
 *   → 苹果 / iPhone 16 Pro
 */
function normalizeTitle(raw, hint, opts = {}) {
  let title = normText(raw);
  for (const w of PROMO_WORDS) title = title.split(w).join(' ');
  title = title.replace(/\s+/g, ' ').trim();

  let brand = detectBrand(title);

  /* Wikidata 的标签多数以品牌开头（Google Pixel 9 / Nokia X30）；
     认不出来时，把第一个词当品牌（能映射到规范名就映射） */
  if (!brand && opts.firstTokenBrand) {
    const first = title.split(' ')[0];
    if (first && /^[A-Za-z\u4e00-\u9fa5]{2,20}$/.test(first)) {
      const canon = BRANDS.find(([, aliases]) =>
        aliases.some((a) => a.toLowerCase() === first.toLowerCase()))?.[0];
      brand = { canon: canon || first, alias: first, index: 0, fallback: true, firstToken: true };
    }
  }
  if (!brand) return null;
  const catGuess = guessCategory(title, hint);

  /* 把标题里所有品牌别名换成空格，只留型号部分（产品线反推时不删） */
  let rest = title;
  if (brand.firstToken) {
    rest = rest.replace(new RegExp('^\\s*' + brand.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '');
  } else if (!brand.fallback) {
    /* 品牌别名按长度从长到短替换：先去掉 "Sony Ericsson"，再处理 "Sony" */
    const allAliases = BRANDS.flatMap(([, aliases]) => aliases)
      .sort((a, b) => b.length - a.length);
    for (const alias of allAliases) {
      rest = rest.replace(new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
    }
  }
  rest = rest.replace(/\s+/g, ' ').trim();

  const tokens = rest.split(' ').filter(Boolean);
  const modelParts = [];
  for (const token of tokens) {
    const clean = token.replace(/^[,，、·/]+|[,，、·/]+$/g, '');
    if (!clean) continue;
    if (isStop(clean, catGuess)) break;
    modelParts.push(clean);
    if (modelParts.length >= 6) break;
  }

  if (!modelParts.length) return null;
  /* 型号开头如果又写了一遍品牌的拉丁名（Google Pixel 9），去掉 */
  const latin = BRAND_LATIN[brand.canon];
  if (latin && modelParts[0] && modelParts[0].toLowerCase() === latin.toLowerCase()) {
    modelParts.shift();
  }
  if (!modelParts.length) return null;
  let model = modelParts.join(' ').trim();
  /* 统一 iPhone 的写法（维基上偶尔写成 IPhone） */
  model = model.replace(/^iphone\b/i, 'iPhone');
  /* 去掉维基标签末尾的 "model"/"product" 这种说明词 */
  model = model.replace(/\s+(model|product)$/i, '').trim();
  if (!model) return null;

  return {
    brand: brand.canon,
    model,
    category: catGuess,
    key: compact(brand.canon + '|' + model),
    display: `${brand.canon} ${model}`,
  };
}

/** 短词（≤2 字符）用边界匹配，避免 "24GB" 里的 "4G" 被当成手机 */
function hasWord(text, w) {
  if (w.length > 2) return text.toLowerCase().includes(w.toLowerCase());
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)', 'i').test(text);
}

function guessCategory(title, hint) {
  for (const [cat, words] of CATEGORY_GUESS) {
    if (words.some((w) => hasWord(title, w))) return cat;
  }
  return hint || null;      /* 标题里看不出来时，才用查询词兜底 */
}

/* ============================================================
 * 供应商：京东联盟 / 模拟
 * ============================================================ */

function jdSign(params, secret) {
  const raw = Object.keys(params).sort().map((k) => k + String(params[k])).join('');
  return createHash('md5').update(secret + raw + secret, 'utf8').digest('hex').toUpperCase();
}

function jdTimestamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');   /* taste-skill-ignore：时间戳补零 */
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const JD_PROVIDER = {
  id: 'jd',
  label: '京东联盟商品搜索',
  async fetchPage(query, pageIndex) {
    const key = process.env.JD_UNION_KEY;
    const secret = process.env.JD_UNION_SECRET;
    if (!key || !secret) {
      throw new Error(
        '缺少环境变量 JD_UNION_KEY / JD_UNION_SECRET。\n' +
        '   设置方法见 README「接真实价格」。先用 --provider mock 看管线。'
      );
    }
    const params = {
      method: 'jd.union.open.goods.query',
      app_key: key,
      sign_method: 'md5',
      timestamp: jdTimestamp(),
      format: 'json',
      v: '1.0',
      keyword: query,
      pageIndex: String(pageIndex),
      pageSize: '20',
    };
    const res = await fetch('https://api.jd.com/routerjson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, sign: jdSign(params, secret) }),
    });
    if (!res.ok) throw new Error(`京东接口 HTTP ${res.status}`);
    const payload = await res.json();
    const resp = payload.jd_union_open_goods_query_response;
    if (!resp) {
      console.error('   接口返回（前 300 字符）：', JSON.stringify(payload).slice(0, 300));
      throw new Error('返回里没有 jd_union_open_goods_query_response —— 多半是密钥不对，或应用还没开通「商品查询」权限');
    }
    const raw = resp.result ?? resp.getResult;
    let data = raw;
    if (typeof raw === 'string') data = JSON.parse(raw);
    const list = Array.isArray(data?.data) ? data.data : [];
    return {
      items: list.map((it) => ({
        sku: String(it.skuId ?? ''),
        title: it.skuName || '',
        price: Number(it.priceInfo?.price ?? it.priceInfo?.lowestPrice ?? NaN),
        shop: it.shopInfo?.shopName || '',
        source: 'jd',
        sourceUrl: it.skuId ? `https://item.jd.com/${it.skuId}.html` : '',
      })),
      total: Number(data?.totalCount ?? list.length),
    };
  },
};

const MOCK_TITLES = [
  '【政府补贴】小米 Xiaomi 15 徕卡光学 16GB+512GB 白色 5G手机',
  '小米15 12GB+256GB 黑色 官方旗舰店 正品国行 5G手机',
  'Redmi K80 16GB+512GB 雪岩白 5G手机 骁龙8Gen3',
  '红米K80 12GB+256GB 曜石黑 全网通 官方自营',
  'Apple/苹果 iPhone 16 Pro 256GB 原色钛金属 5G手机',
  'Apple iPhone 16 Pro 512GB 黑色钛金属 官方旗舰店',
  'iPhone 16 128GB 白色 5G手机 国行正品',
  '华为 HUAWEI Mate 70 Pro 12GB+512GB 曜石黑 鸿蒙',
  'HUAWEI Mate 70 256GB 雪域白 5G手机 官方旗舰店',
  '荣耀 HONOR MagicBook X16 Pro 16GB+1TB 星空灰 轻薄本',
  '联想小新 Pro 14 2025 锐龙R7 16GB 1TB 2.8K 120Hz 轻薄本',
  'ThinkBook 16p 2025 32GB 1TB RTX4060 创作本',
  'MacBook Air 13 M4 16GB 256GB 午夜色 笔记本电脑',
  'Apple MacBook Pro 14 M4 Pro 24GB 512GB 深空黑',
  'Sony/索尼 ZV-E10 II 微单相机 4K60 侧翻屏 官方旗舰店',
  '索尼 ZV-E10 II 16-50套机 微单相机 白色',
  '佳能 EOS 200D II 单反相机 18-55套机 官方旗舰店',
  'Canon/佳能 PowerShot G7 X Mark III 卡片机 黑色',
  '适马 18-50mm F2.8 DC DN 索尼E卡口 变焦镜头',
  'Sigma 18-50mm F2.8 DC DN 富士X卡口 镜头 官方',
  '索尼 FE 50mm F1.8 全画幅定焦镜头 官方旗舰店',
  'DJI 大疆 Osmo Action 5 Pro 运动相机 标准套装',
  '大疆 Action 5 Pro 畅拍套装 官方自营 运动相机',
  '华为 WATCH GT 5 46mm 黑色 智能手表 官方旗舰店',
  'Apple Watch SE 40mm 午夜色 智能手表',
  '小米手环10 NFC版 黑色 智能手环 官方',
  'Keychron K3 Pro 矮轴机械键盘 75% 蓝牙',
  '罗技 MX Master 3S 无线鼠标 石墨黑 官方旗舰店',
  '闪迪至尊高速 USB-C 闪存盘 256GB 金属外壳',
];

const MOCK_PROVIDER = {
  id: 'mock',
  label: '模拟数据（验证清洗管线）',
  async fetchPage(query, pageIndex) {
    const size = 10;
    const start = (pageIndex - 1) * size;
    const slice = MOCK_TITLES.slice(start, start + size);
    return {
      items: slice.map((title, i) => ({
        sku: 'mock-' + (start + i + 1),
        title,
        price: 199 + ((start + i) * 137) % 9000,
        shop: '模拟店铺',
        source: 'mock',
        sourceUrl: '',
      })),
      total: MOCK_TITLES.length,
    };
  },
};

/* ============================================================
 * Wikidata（CC0）：只要设备名称时的最佳来源
 * ------------------------------------------------------------
 * 免备案、免密钥。按「型号类」查：智能手机、笔记本、平板、数码相机、
 * 智能手表、镜头、键鼠显示器、耳机。标签优先中文，没有就用英文。
 * 速率：每次请求间隔 1.2 秒；每个细分类默认最多 200 条（--limit 可调）。
 * ============================================================ */

const WIKIDATA_CLASSES = {
  phone: [
    { q: 'Q19723451', label: '智能手机' },
    { q: 'Q19723444', label: '手机（含功能机）' },
  ],
  laptop: [{ q: 'Q73343954', label: '笔记本' }],
  tablet: [{ q: 'Q113990168', label: '平板' }],
  camera: [{ q: 'Q20741022', label: '数码相机' }],
  wearable: [{ q: 'Q19799938', label: '智能手表' }],
  lens: [{ q: 'Q109672300', label: '镜头' }],
  peripheral: [
    { q: 'Q128558307', label: '键盘' },
    { q: 'Q135902762', label: '鼠标' },
    { q: 'Q136260412', label: '显示器' },
  ],
  accessory: [{ q: 'Q127604337', label: '耳机' }],
};

const WIKIDATA_PROVIDER = {
  id: 'wikidata',
  label: 'Wikidata（CC0，免备案）',

  async query(qid, limit, offset) {
    const sparql = `SELECT ?item ?itemLabel ?brandLabel WHERE {
  ?item wdt:P31 wd:${qid} .
  OPTIONAL { ?item wdt:P176 ?brand . }
  ?item wikibase:sitelinks ?links .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh,en". }
} ORDER BY DESC(?links) LIMIT ${limit} OFFSET ${offset}`;

    const res = await fetch('https://query.wikidata.org/sparql?format=json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/sparql-results+json',
        'User-Agent': 'digivue-discovery/1.0 (https://digivue.top)',
      },
      body: new URLSearchParams({ query: sparql }),
    });
    if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
    const data = await res.json();
    const rows = data.results?.bindings || [];
    const items = rows
      .map((b) => ({
        sku: String(b.item?.value || '').split('/').pop(),
        title: b.itemLabel?.value || '',
        brandHint: b.brandLabel?.value || '',
        source: 'wikidata',
        sourceUrl: b.item?.value || '',
      }))
      /* 过滤维基里的垃圾标签（unidentified…）和没有名字的 QID */
      .filter((it) => it.title && !/^Q\d+$/.test(it.title) && !/unidentified/i.test(it.title));
    return { items, raw: rows.length };
  },
};

/* ============================================================
 * 与现有产品库比对
 * ============================================================ */

function loadCatalog() {
  const src = readFileSync(join(ROOT, 'data.js'), 'utf8');
  const sandbox = { console, window: null };
  sandbox.window = sandbox;
  createContext(sandbox);
  runInContext(src + '\n;globalThis.__OUT = { PRODUCTS };', sandbox);
  return sandbox.__OUT.PRODUCTS;
}

/* ============================================================
 * 主流程
 * ============================================================ */

async function main() {
  const provider = PROVIDER === 'mock' ? MOCK_PROVIDER
    : PROVIDER === 'wikidata' ? WIKIDATA_PROVIDER
    : JD_PROVIDER;
  const isWiki = provider.id === 'wikidata';

  console.log(`\n🔎 型号发现：${provider.label}`);
  console.log(isWiki
    ? `   分类：${CLASSES.join(', ')} · 每类上限：${LIMIT}\n`
    : `   关键词：${QUERY} · 页数：${PAGES}\n`);

  const raw = [];
  if (isWiki) {
    for (const cls of CLASSES) {
      const defs = WIKIDATA_CLASSES[cls];
      if (!defs) { console.warn(`   跳过未知分类：${cls}`); continue; }
      for (const def of defs) {
        let offset = 0;
        while (offset < LIMIT) {
          const want = Math.min(500, LIMIT - offset);
          let res;
          try {
            res = await provider.query(def.q, want, offset);
          } catch (err) {
            console.error(`❌ ${def.label} 取数失败：${err.message}`);
            process.exit(1);
          }
          raw.push(...res.items.map((it) => ({ ...it, category: cls })));
          console.log(`   ${def.label}：${offset + res.raw} 条（累计 ${raw.length}）`);
          offset += want;
          if (res.raw < want) break;
          await new Promise((r) => setTimeout(r, 1200));   /* 对 Wikidata 客气一点 */
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  } else {
    for (let page = 1; page <= PAGES; page++) {
      let res;
      try {
        res = await provider.fetchPage(QUERY, page);
      } catch (err) {
        console.error(`❌ 第 ${page} 页取数失败：${err.message}`);
        process.exit(1);
      }
      raw.push(...res.items);
      console.log(`   第 ${page} 页：${res.items.length} 条（累计 ${raw.length}）`);
      if (!res.items.length) break;
      if (PROVIDER === 'jd') await new Promise((r) => setTimeout(r, 400)); /* 对接口客气一点 */
    }
  }

  /* 清洗 → 按「品牌+型号」聚合变体 */
  const groups = new Map();
  let unparsed = 0;
  const unparsedTitles = [];
  const hint = CATEGORY_HINT || guessCategory(QUERY);
  for (const item of raw) {
    const norm = normalizeTitle(item.title, hint, { firstTokenBrand: isWiki });
    if (!norm) { unparsed++; if (unparsedTitles.length < 8) unparsedTitles.push(item.title); continue; }
    const g = groups.get(norm.key) || {
      key: norm.key, brand: norm.brand, model: norm.model, display: norm.display,
      category: item.category || norm.category,
      source: item.source || provider.id,
      sourceUrl: item.sourceUrl || '',
      offers: [], minPrice: Infinity, maxPrice: 0,
    };
    g.offers.push({
      sku: item.sku, price: item.price, shop: item.shop, title: item.title,
      source: item.source || provider.id, sourceUrl: item.sourceUrl || '',
    });
    if (Number.isFinite(item.price)) {
      g.minPrice = Math.min(g.minPrice, item.price);
      g.maxPrice = Math.max(g.maxPrice, item.price);
    }
    groups.set(norm.key, g);
  }

  /* 和现有产品库比对 */
  const catalog = loadCatalog();
  const catalogKeys = new Set(catalog.map((p) => compact((p.brand || '') + '|' + (p.name || '').replace(p.brand || '', ''))));
  const catalogLoose = catalog.map((p) => ({ brand: compact(p.brand || ''), name: compact(p.name || '') }));

  /* 同一品牌下，一个型号是另一个的后缀就合并（Osmo Action 5 Pro / Action 5 Pro）。
     只合并后缀：Mate 70 是 Mate 70 Pro 的前缀，属于不同型号，不能并。 */
  const sorted = [...groups.values()].sort((a, b) => b.model.length - a.model.length);
  const deduped = [];
  for (const g of sorted) {
    const target = deduped.find((m) =>
      m.brand === g.brand &&
      (compact(m.model).endsWith(compact(g.model)) || compact(g.model).endsWith(compact(m.model))));
    if (target) {
      target.offers.push(...g.offers);
      target.minPrice = Math.min(target.minPrice, g.minPrice);
      target.maxPrice = Math.max(target.maxPrice, g.maxPrice);
    } else {
      deduped.push(g);
    }
  }

  const candidates = deduped.map((g) => ({
    ...g,
    variants: g.offers.length,
    inCatalog: catalogLoose.some((c) =>
      (c.brand === compact(g.brand) && (c.name.includes(compact(g.model)) || compact(g.model).includes(c.name)))
      || catalogKeys.has(compact(g.brand + '|' + g.model))),
  }));

  /* 合并历史结果（跨多次查询累积） */
  mkdirSync(DATA_DIR, { recursive: true });
  let store = { generatedAt: null, queries: [], candidates: [] };
  if (!FRESH && existsSync(OUT_JSON)) {
    try { store = JSON.parse(readFileSync(OUT_JSON, 'utf8')); } catch { /* 坏文件就重建 */ }
  }
  const merged = new Map((store.candidates || []).map((c) => [c.key, c]));
  const now = new Date().toISOString();
  for (const c of candidates) {
    const prev = merged.get(c.key) || {};
    merged.set(c.key, {
      ...prev, ...c,
      firstSeenAt: prev.firstSeenAt || now,
      lastSeenAt: now,
    });
  }

  const out = {
    generatedAt: now,
    provider: provider.id,
    queries: [...new Set([...(store.queries || []), QUERY])],
    stats: {
      raw: raw.length,
      parsed: raw.length - unparsed,
      unparsed,
      models: merged.size,
      alreadyInCatalog: [...merged.values()].filter((c) => c.inCatalog).length,
    },
    candidates: [...merged.values()].sort((a, b) =>
      (a.category || 'zz').localeCompare(b.category || 'zz') ||
      (a.minPrice || 0) - (b.minPrice || 0)),
  };
  writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), 'utf8');

  /* 人看的 CSV */
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ['brand', 'model', 'display', 'category', 'variants', 'minPrice', 'maxPrice', 'inCatalog', 'source', 'exampleTitle', 'sku', 'sourceUrl'],
    ...out.candidates.map((c) => [
      c.brand, c.model, c.display, c.category || '', c.variants,
      Number.isFinite(c.minPrice) ? c.minPrice : '', c.maxPrice || '',
      c.inCatalog ? '已有' : '新增',
      c.source || '',
      c.offers[0]?.title || '', c.offers[0]?.sku || '', c.offers[0]?.sourceUrl || '',
    ]),
  ];
  writeFileSync(OUT_CSV, '\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\r\n'), 'utf8');

  /* 终端小结 */
  console.log(`\n✅ 完成`);
  console.log(`   原始条目：${out.stats.raw} · 可解析：${out.stats.parsed} · 丢掉的：${out.stats.unparsed}`);
  if (unparsedTitles.length) {
    console.log(`   丢掉的样例（多半是品牌不在词表里）：${unparsedTitles.join(' / ')}`);
  }
  console.log(`   去重后型号：${out.stats.models} · 库里已有：${out.stats.alreadyInCatalog}`);
  console.log(`\n   输出：`);
  console.log(`     data/candidates.json   机器用（含全部 SKU 变体）`);
  console.log(`     data/candidates.csv    人用（Excel 打开直接审核）`);

  console.log(`\n   新增型号（前 15 条）：`);
  out.candidates.filter((c) => !c.inCatalog).slice(0, 15).forEach((c) => {
    console.log(`     [${c.category || '?'}] ${c.display}  ¥${Number.isFinite(c.minPrice) ? c.minPrice : '—'}  ×${c.variants}`);
  });
  if (out.candidates.some((c) => !c.inCatalog)) {
    console.log(`\n   下一步：打开 data/candidates.csv，把要收录的型号挑出来，`);
    console.log(`   我再按清单补参数、绑定 SKU、生成页面。`);
  }
}

main().catch((err) => {
  console.error('❌ 未预期的错误：', err);
  process.exit(1);
});
