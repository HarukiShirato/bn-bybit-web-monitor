import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * 图标本地化：把外部 CDN 的图抓到服务器上，前端此后只打自己的域名。
 * 上游（bnbstatic / coingecko / coincap / fmp）随时可能限流、改地址或下架，
 * 存一份在本地就与它们彻底解耦。
 *
 * 下载在后台进行，不阻塞 API：首次仍返回外链，落盘后下一次请求换成本地地址。
 */
export const ICON_DIR = path.join(process.cwd(), 'data', 'icons');

const MAX_PARALLEL = 6;
const MAX_BYTES = 512 * 1024; // 单张图上限，异常大的直接放弃

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/gif': 'gif',
};

const inFlight = new Set<string>();
const failed = new Map<string, number>(); // key -> 失败次数，连续失败就不再试

/** `stock:SNDK` -> `stock_SNDK`，用作文件名 */
function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9]+/g, '_');
}

/** 已经存在的本地文件（同名不同扩展名） */
function findLocal(key: string): string | null {
  try {
    if (!fs.existsSync(ICON_DIR)) return null;
    const base = safeName(key);
    for (const ext of ['png', 'jpg', 'webp', 'svg', 'gif']) {
      const f = `${base}.${ext}`;
      if (fs.existsSync(path.join(ICON_DIR, f))) return f;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 本地文件对应的对外地址 */
export function localUrl(file: string): string {
  return `/api/icon/${file}`;
}

/** 已本地化就返回地址，否则触发后台下载并返回 null */
export function localIconFor(key: string, remoteUrl: string): string | null {
  const existing = findLocal(key);
  if (existing) return localUrl(existing);
  queueDownload(key, remoteUrl);
  return null;
}

const queue: Array<{ key: string; url: string }> = [];
let running = 0;

function queueDownload(key: string, url: string) {
  if (inFlight.has(key)) return;
  if ((failed.get(key) ?? 0) >= 2) return; // 试过两次都不行就算了
  if (!/^https?:\/\//.test(url)) return;
  inFlight.add(key);
  queue.push({ key, url });
  pump();
}

function pump() {
  while (running < MAX_PARALLEL && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    download(job.key, job.url)
      .catch(() => {})
      .finally(() => {
        running--;
        inFlight.delete(job.key);
        pump();
      });
  }
}

async function download(key: string, url: string) {
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: MAX_BYTES,
      validateStatus: s => s === 200,
    });

    const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    const buf = Buffer.from(res.data);
    // CoinCap 的 404 会返回 153 字节的占位内容，按大小挡掉
    if (!ext || buf.length < 300) {
      failed.set(key, (failed.get(key) ?? 0) + 1);
      return;
    }

    if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true });
    const tmp = path.join(ICON_DIR, `.${safeName(key)}.tmp`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, path.join(ICON_DIR, `${safeName(key)}.${ext}`)); // 原子替换，避免读到半个文件
  } catch {
    failed.set(key, (failed.get(key) ?? 0) + 1);
  }
}

/** 连续失败到上限，认定这个 key 没有可用图 */
export function isDeadIcon(key: string): boolean {
  return (failed.get(key) ?? 0) >= 2;
}

export function iconStoreStats() {
  try {
    const files = fs.existsSync(ICON_DIR) ? fs.readdirSync(ICON_DIR).filter(f => !f.startsWith('.')) : [];
    return { stored: files.length, queued: queue.length, running };
  } catch {
    return { stored: 0, queued: queue.length, running };
  }
}
