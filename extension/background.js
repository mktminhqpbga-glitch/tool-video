import { readProductPage } from './extract.js';

const local = 'http://127.0.0.1:8765';
let working = false;

function enable() {
  void chrome.alarms.create('affiliate-process', { periodInMinutes: 0.5 });
  void processOne();
}
chrome.runtime.onInstalled.addListener(enable);
chrome.runtime.onStartup.addListener(enable);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'affiliate-process') void processOne(); });
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'process') enable();
});

async function backend(endpoint, key, data) {
  const response = await fetch(local + '/api/extension/' + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Extension-Key': key },
    body: JSON.stringify(data), signal: AbortSignal.timeout(26000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || 'App chưa phản hồi.');
  return payload;
}

async function waitForPage(tabId) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url && !tab.url.startsWith('about:')) return;
    await new Promise(resolve => setTimeout(resolve, 850));
  }
}

const imageHosts = /(?:^|\.)(?:shopeemobile\.com|shopee\.vn|susercontent\.com|tiktok\.com|tiktokcdn(?:-us|-eu)?\.com|tiktokv\.com|ibyteimg\.com|byteoversea\.com|ibytedtos\.com|ttwstatic\.com)$/i;
async function readImage(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || !imageHosts.test(url.hostname)) return null;
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(6500) });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 8 * 1024 * 1024) return null;
    const type = (response.headers.get('content-type') || '').split(';')[0];
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { await reader.cancel(); return null; }
      chunks.push(chunk);
    }
    const blob = new Blob(chunks, { type });
    const decoded = await createImageBitmap(blob);
    decoded.close();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return 'data:' + type + ';base64,' + btoa(binary);
  } catch { return null; }
}

async function collect(tabId) {
  await waitForPage(tabId);
  let data;
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    try {
      const result = await chrome.scripting.executeScript({ target: { tabId }, func: readProductPage });
      data = result[0]?.result;
      if (data?.state === 'login' || (data?.state === 'ok' && data.name && data.urls.length)) break;
    } catch {
      // The tab can still be redirecting. A later attempt can read the final page.
    }
  }
  if (!data) return { state: 'error', message: 'Chrome chưa đọc được trang. Kiểm tra link và quyền của extension.' };
  const { urls, ...product } = data;
  if (!urls) return product;
  const images = (await Promise.all(urls.map(readImage))).filter(Boolean);
  const limited = [];
  let total = 0;
  for (const image of images) {
    if (total + image.length > 55 * 1024 * 1024) continue;
    limited.push(image);
    total += image.length;
  }
  return { ...product, images: limited };
}

async function processOne() {
  if (working) return;
  working = true;
  let tab;
  let claim;
  let key;
  let keep = false;
  let submitted = false;
  try {
    ({ extensionKey: key } = await chrome.storage.local.get('extensionKey'));
    if (!key) return;
    claim = await backend('claim', key, {});
    await chrome.storage.local.set({ lastStatus: 'Đã kết nối app cục bộ.' });
    if (!claim.id) return;
    tab = await chrome.tabs.create({ url: claim.link.replace(/^http:/, 'https:'), active: false });
    const result = await collect(tab.id);
    keep = result.state === 'login';
    if (keep) await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    submitted = true;
    await backend('result', key, { ...claim, ...result });
    await chrome.storage.local.set({ lastStatus: keep ? 'Cần đăng nhập trên tab sản phẩm.' : 'Đã gửi kết quả lấy dữ liệu.' });
  } catch (error) {
    const message = error.message === 'Failed to fetch' ? 'Chưa kết nối được app. Mở ứng dụng local rồi thử lại.' : error.message;
    await chrome.storage.local.set({ lastStatus: message });
    if (claim?.id && !submitted) await backend('result', key, { ...claim, state: 'error', message: 'Chrome gặp lỗi khi lấy dữ liệu. Mở app để lấy lại hoặc nhập thủ công.' }).catch(() => {});
  } finally {
    if (tab && !keep) await chrome.tabs.remove(tab.id).catch(() => {});
    working = false;
  }
}
