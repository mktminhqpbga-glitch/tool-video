import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { now, store } from './store.mjs';

export function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function productUrl(value) {
  if (typeof value !== 'string' || value.length > 2500) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const platform = /(^|\.)shopee\.vn$/.test(host) || host === 'shp.ee' ? 'shopee'
      : /(^|\.)tiktok\.com$/.test(host) ? 'tiktok' : '';
    return platform ? { url, platform } : null;
  } catch { return null; }
}

export function identity(input, extractedId = '') {
  const parsed = productUrl(input);
  if (!parsed) return null;
  const { url, platform } = parsed;
  let id;
  if (platform === 'shopee') {
    const match = url.pathname.match(/(?:\/product\/|(?:^|[/-])i\.)(\d+)[/.](\d+)(?:$|\/)/i);
    id = match ? match.slice(1).join(':') : /^\d+:\d+$/.test(extractedId) ? extractedId : '';
  } else {
    id = url.pathname.match(/\/(?:product|view\/product|shop\/pdp(?:\/[^/]+)?)\/(\d{5,})(?:\/|$)/i)?.[1]
      || (/^\d{5,}$/.test(extractedId) ? extractedId : '');
  }
  if (id) return { key: platform + ':' + id, id, platform };
  if (/\/(?:product|item|view\/product|shop\/pdp)\//i.test(url.pathname)) {
    return { key: platform + ':url:' + url.hostname + url.pathname.replace(/\/$/, ''), id: '', platform };
  }
  return null;
}

export function asset(value) {
  const match = typeof value === 'string' && value.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || match[2].length > 14_000_000) throw problem('BAD_IMAGE', 'Ảnh phải là PNG, JPEG, WEBP hoặc GIF, tối đa 10 MB.');
  const bytes = Buffer.from(match[2], 'base64');
  const first = bytes.toString('hex', 0, 8);
  const signatures = { png: /^89504e470d0a1a0a/, jpeg: /^ffd8ff/, gif: /^47494638/, webp: /^52494646/ };
  if (bytes.length < 24 || bytes.length > 10 * 1024 * 1024 || !signatures[match[1]].test(first)
    || (match[1] === 'webp' && bytes.toString('ascii', 8, 12) !== 'WEBP')) {
    throw problem('BAD_IMAGE', 'Không nhận diện được ảnh. Hãy mở ảnh trên máy hoặc thử tệp khác.');
  }
  const file = randomUUID() + '.' + match[1];
  writeFileSync(resolve(store.dir, 'assets', file), bytes);
  return file;
}

export function createBatch(input) {
  const links = String(input ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!links.length || links.length > 100) throw problem('LINK_COUNT', 'Mỗi đợt cần từ 1 đến 100 dòng link.');
  const seen = new Map();
  const batch = { id: randomUUID(), created: now(), lines: links.map(link => {
    const id = randomUUID();
    if (!productUrl(link)) return { id, link: link.slice(0, 2500), stage: 'invalid', detail: 'Dùng link Shopee Việt Nam hoặc TikTok Shop.' };
    const alias = seen.get(link);
    if (alias) return { id, link, alias, stage: 'duplicate' };
    seen.set(link, id);
    const known = identity(link);
    const product = known && store.state.products.find(entry => entry.key === known.key);
    return product ? { id, link, productId: product.id, stage: 'duplicate' } : { id, link, stage: 'queued' };
  }) };
  store.state.batches.unshift(batch);
  return batch;
}

export function newJob(product, options = {}) {
  const job = { id: randomUUID(), productId: product.id, number: 1 + store.state.jobs.filter(entry => entry.productId === product.id).length,
    step: options.script ? 'submit' : options.templateId ? 'script' : 'classify', created: now(), ...options };
  store.state.jobs.push(job);
  return job;
}

export function acceptProduct(line, data) {
  const source = productUrl(data.url);
  if (!source || source.platform !== productUrl(line.link)?.platform) throw problem('PRODUCT_REDIRECT', 'Link chuyển đến trang ngoài sàn đã chọn.');
  const recognized = identity(data.url, String(data.productId ?? ''));
  if (!recognized) throw problem('PRODUCT_ID', 'Chưa nhận diện được trang sản phẩm. Hãy dùng link trực tiếp hoặc nhập hồ sơ thủ công.');
  const existing = store.state.products.find(entry => entry.key === recognized.key || entry.canonical === source.url.origin + source.url.pathname);
  if (existing) {
    if (!existing.externalId && recognized.id) {
      existing.externalId = recognized.id;
      existing.key = recognized.key;
    }
    Object.assign(line, { stage: 'duplicate', productId: existing.id });
    return;
  }
  const images = [];
  for (const value of Array.isArray(data.images) ? data.images.slice(0, 12) : []) {
    try { images.push(asset(value)); } catch (error) { if (error.code !== 'BAD_IMAGE') throw error; }
  }
  const product = {
    id: randomUUID(), key: recognized.key, platform: recognized.platform, externalId: recognized.id,
    canonical: source.url.origin + source.url.pathname, source: line.link, name: String(data.name ?? '').trim().slice(0, 250),
    description: String(data.description ?? '').trim().slice(0, 12000), variant: String(data.variant ?? '').trim().slice(0, 250),
    images, affiliate: '', created: now(),
  };
  store.state.products.unshift(product);
  const job = newJob(product);
  Object.assign(line, { stage: 'linked', productId: product.id, jobId: job.id });
}
