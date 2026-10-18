/* 读取项目根目录的 .env（KEY=VALUE 一行一个）。
 * 只在本机生效；已经存在的环境变量优先，不会被 .env 覆盖。
 * 这样不会写环境变量的人也能用：用记事本填三行就行。 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnv(root) {
  const file = join(root, '.env');
  if (!existsSync(file)) return;

  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && value && !process.env[key]) process.env[key] = value;
  }
}
