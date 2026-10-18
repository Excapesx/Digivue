#!/usr/bin/env node
/* ============================================================
 * 构建产物自检 —— 不依赖浏览器的快速检查
 * ------------------------------------------------------------
 *   node verify.mjs
 *
 * 它做四件事：
 *   1. data.js 能在沙箱里跑通（数据自检会自己打印结论）
 *   2. app.js 语法正确（只解析，不执行）
 *   3. dist/ 里的页面齐不齐：首页、每款产品页、工具箱、榜单、AI资讯
 *   4. 每个产品页里真的写进了参数文字（SEO 的全部意义）
 *
 * 想看渲染效果，用 build.mjs 打印的本地预览命令；
 * 想量真实渲染（字号、对比度、溢出），用 taste-skill 的 inspect.mjs。
 * ============================================================ */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, Script } from 'node:vm';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');

const problems = [];

/* 与 build.mjs 同一套转义：参数里可能有引号，静态页里存的是 &quot; */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/* ---------- 1 + 2：数据与脚本 ---------- */
const dataSrc = readFileSync(join(ROOT, 'data.js'), 'utf8');
const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
createContext(sandbox);
runInContext(
  dataSrc + '\n;globalThis.__OUT = { CATEGORIES, SPEC_FIELDS, PRODUCTS, productPath };',
  sandbox
);
const { CATEGORIES, PRODUCTS, productPath } = sandbox.__OUT;

try {
  new Script(readFileSync(join(ROOT, 'app.js'), 'utf8'));   // 只解析
  console.log('① app.js 语法检查通过');
} catch (err) {
  problems.push(`app.js 语法错误：${err.message}`);
}

/* ---------- 3：页面是否齐全 ---------- */
if (!existsSync(join(DIST, 'index.html'))) problems.push('dist/index.html 不存在，先跑 node build.mjs');

for (const sub of ['tools', 'ranking', 'news']) {
  if (!existsSync(join(DIST, sub, 'index.html'))) problems.push(`缺少内页：${sub}/index.html`);
}

for (const p of PRODUCTS) {
  const rel = join(productPath(p), 'index.html');
  const full = join(DIST, rel);
  if (!existsSync(full)) { problems.push(`缺少产品页：${rel}`); continue; }

  /* ---------- 4：参数必须是纯文字 ---------- */
  const html = readFileSync(full, 'utf8');
  const firstSpec = String(Object.values(p.specs)[0]);
  if (firstSpec && !html.includes(firstSpec) && !html.includes(esc(firstSpec))) {
    problems.push(`${rel} 里没有参数文字（SEO 会读不到）`);
  }
}

/* ---------- 结论 ---------- */
console.log(
  `② 产品数据：${PRODUCTS.length} 款 · ${CATEGORIES.length} 个品类`
);

if (problems.length) {
  console.log(`\n⚠️  自检发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log('   - ' + p);
  process.exit(1);
}

console.log('\n✅ 自检通过：页面齐全，产品页含真实参数文字。');
