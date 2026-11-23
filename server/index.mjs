import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptProduct, asset, createBatch, newJob, problem, productUrl } from './products.mjs';
import { diagnostic, openStore, publicSettings, save, store } from './store.mjs';
import { finishGoogle, mac, macUrl, oauthRedirect, origin, startGoogle } from './services.mjs';
import { status, tick, validateScript } from './workflow.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = 8765;
const appHost = '127.0.0.1:' + port;
const mime = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const actions = {
  MAC_KEY: 'Mở Cài đặt và nhập khóa mac2API.',
  MAC_401: 'Kiểm tra khóa trong mac2API hoặc tạo khóa người dùng mới.',
  MAC_403: 'Cấp quyền cho model đang chọn trong mac2API.',
  MAC_NETWORK: 'Mở mac2API và kiểm tra địa chỉ trong Cài đặt.',
  GOOGLE_CONNECT: 'Kết nối Google Drive rồi thử lại bước lưu.',
  GOOGLE_AUTH: 'Kết nối lại Google Drive rồi thử lại bước lưu.',
  SCRIPT_PRICE: 'Sửa prompt hoặc chọn mẫu khác rồi thử lại.',
};
const lookup = (entries, id, name = 'Mục') => {
  const result = entries.find(entry => entry.id === id);
  if (!result) throw problem('NOT_FOUND', name + ' không tồn tại.', 404);
  return result;
};

function text(value, limit = 200) { return String(value ?? '').trim().slice(0, limit); }
function number(value, min, max, name) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw problem('SETTINGS_VALUE', name + ' phải từ ' + min + ' đến ' + max + '.');
  return result;
}
function webUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2500) return url.href;
  } catch { /* Fall through to the user-facing error. */ }
  throw problem('BAD_URL', 'Nhập địa chỉ web bắt đầu bằng https:// hoặc http://.');
}
function sameKey(header, key) {
  const candidate = Buffer.from(typeof header === 'string' ? header : '');
  const expected = Buffer.from(key);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function stateView() {
  const { products, jobs, templates, defaultTemplate, batches, errors } = store.state;
  return {
    products, templates, defaultTemplate, settings: publicSettings(), oauthRedirect,
    jobs: jobs.map(({ key, result, connection, driveUploadId, ...job }) => ({ ...job,
      stage: status(job, products.find(product => product.id === job.productId)),
    })),
    batches: batches.map(batch => ({ ...batch, lines: batch.lines.map(line => {
      const { claim, lease, ...view } = line;
      const match = line.alias ? batch.lines.find(entry => entry.id === line.alias) : line;
      const productId = match.productId;
      const job = jobs.find(entry => entry.id === match.jobId) || jobs.find(entry => entry.productId === productId);
      const product = products.find(entry => entry.id === productId);
      return { ...view, productId, current: job && status(job, product) };
    }) })),
    errors: errors.map(entry => ({ ...entry, suggestion: actions[entry.code] || '' })),
  };
}

function resumeAfterSetup(codes) {
  for (const job of store.state.jobs) {
    if (!codes.includes(job.issue?.code)) continue;
    delete job.issue;
    delete job.attempts;
    delete job.nextAt;
  }
}

function settingsUpdate(input) {
  const current = store.state.settings;
  const settings = { ...current };
  const fields = ['textModel', 'videoModel', 'resolution', 'googleClient', 'googleRootName'];
  if ('macBase' in input) settings.macBase = macUrl(input.macBase);
  for (const name of fields) if (name in input) settings[name] = text(input[name]);
  if (!settings.textModel || !settings.videoModel || !settings.googleRootName) throw problem('EMPTY_SETTINGS', 'Cần nhập model văn bản, model video và tên thư mục Drive.');
  if (input.macKey) {
    const key = text(input.macKey, 500);
    if (!/^m2c_[A-Za-z0-9_-]+$/.test(key)) throw problem('MAC_KEY', 'Dùng khóa người dùng bắt đầu bằng m2c_.');
    settings.macKey = key;
  }
  if (input.googleSecret) settings.googleSecret = text(input.googleSecret, 500);
  if (settings.googleClient !== current.googleClient || settings.googleSecret !== current.googleSecret) {
    if (settings.googleToken) throw problem('GOOGLE_ACCOUNT', 'Ngắt kết nối Google Drive trước khi đổi thông tin OAuth.');
    delete settings.oauth;
  }
  for (const [field, min, max, label] of [
    ['duration', 1, 120, 'Thời lượng'], ['maxImages', 1, 10, 'Số ảnh'], ['parallelVideos', 1, 8, 'Tác vụ đồng thời'],
    ['pollSeconds', 5, 120, 'Khoảng kiểm tra'],
  ]) if (field in input) settings[field] = number(input[field], min, max, label);
  if ('aspect' in input) {
    if (!['9:16', '16:9', '1:1'].includes(input.aspect)) throw problem('ASPECT', 'Chọn một tỷ lệ video hợp lệ.');
    settings.aspect = input.aspect;
  }
  // Keep the same object because the worker can be saving Drive settings concurrently.
  Object.assign(current, settings);
  if (!settings.oauth) delete current.oauth;
  if (input.macKey) resumeAfterSetup(['MAC_KEY']);
}

function editTemplate(data, id) {
  const existing = id ? lookup(store.state.templates, id, 'Mẫu') : null;
  const name = text(data.name);
  const script = text(data.script, 12000);
  const rules = text(data.rules, 12000);
  if (!name || !script || !rules) throw problem('TEMPLATE_FIELDS', 'Nhập tên, prompt viết kịch bản và quy tắc video.');
  const updated = { id: existing?.id || randomUUID(), name, script, rules, group: text(data.group), criteria: text(data.criteria, 2000),
    revision: (existing?.revision || 0) + 1, character: data.character ? asset(data.character) : data.removeCharacter ? null : existing?.character || null };
  if (existing) Object.assign(existing, updated);
  else store.state.templates.push(updated);
  if (data.makeDefault) store.state.defaultTemplate = updated.id;
  else if (store.state.defaultTemplate === updated.id) store.state.defaultTemplate = null;
}

function lineById(id) {
  return lookup(store.state.batches.flatMap(batch => batch.lines), id, 'Dòng nhập');
}

function reportLine(line, code, message) {
  const entry = diagnostic(code, message, { lineId: line.id, step: 'extract' });
  Object.assign(line, { stage: 'extractError', detail: message, report: entry.id });
}

function uploadProductImages(product, values) {
  if (!Array.isArray(values) || !values.length || values.length > 8) throw problem('IMAGE_COUNT', 'Tải lên từ 1 đến 8 ảnh mỗi lần.');
  if (product.images.length + values.length > 30) throw problem('IMAGE_COUNT', 'Hồ sơ lưu được tối đa 30 ảnh.');
  const files = values.map(asset);
  product.images.push(...files);
}

async function api(path, method, body) {
  const state = store.state;
  if (method === 'GET' && path === '/api/state') return stateView();
  if (method === 'GET' && path === '/api/diagnostics') return { app: 'Affiliate Video Local', exported: new Date().toISOString(), errors: stateView().errors };
  if (method !== 'POST') throw problem('NOT_FOUND', 'Không tìm thấy thao tác này.', 404);

  let match;
  if (path === '/api/settings') settingsUpdate(body);
  else if (path === '/api/mac/check') {
    const capabilities = await mac('/capabilities');
    return { models: capabilities.models || [], limits: capabilities.limits || {}, serverVersion: capabilities.serverVersion };
  } else if (path === '/api/google/start') return { url: startGoogle() };
  else if (path === '/api/google/disconnect') {
    delete state.settings.googleToken;
    delete state.settings.oauth;
  } else if (path === '/api/batches') {
    const batch = createBatch(body.links);
    save();
    return { id: batch.id };
  } else if ((match = path.match(/^\/api\/lines\/([^/]+)\/(retry|manual)$/))) {
    const line = lineById(match[1]);
    if (!['extractError', 'login'].includes(line.stage)) throw problem('LINE_STATE', 'Dòng này chưa cần xử lý lại.');
    if (match[2] === 'manual') {
      const source = productUrl(body.url || line.link);
      if (!source) throw problem('PRODUCT_URL', 'Nhập link sản phẩm trực tiếp trên đúng sàn.');
      acceptProduct(line, { ...body, url: source.url.href });
    } else line.stage = 'queued';
    delete line.detail;
    delete line.report;
  } else if (path === '/api/templates') editTemplate(body);
  else if ((match = path.match(/^\/api\/templates\/([^/]+)$/))) editTemplate(body, match[1]);
  else if ((match = path.match(/^\/api\/products\/([^/]+)\/(edit|images|version)$/))) {
    const product = lookup(state.products, match[1], 'Hồ sơ');
    if (match[2] === 'edit') {
      const name = text(body.name, 250);
      if (!name) throw problem('PRODUCT_NAME', 'Nhập tên sản phẩm.');
      Object.assign(product, { name, description: text(body.description, 12000), variant: text(body.variant, 250), affiliate: webUrl(body.affiliate) });
    } else if (match[2] === 'images') uploadProductImages(product, body.images);
    else {
      if (!product.name || !product.images.length) throw problem('PRODUCT_DATA', 'Bổ sung tên và ảnh sản phẩm trước.');
      const templateId = body.templateId ? lookup(state.templates, body.templateId, 'Mẫu').id : undefined;
      const base = body.baseId ? lookup(state.jobs.filter(job => job.productId === product.id), body.baseId, 'Phiên bản') : null;
      const chosenImages = Array.isArray(body.images) ? [...new Set(body.images)] : [];
      if (chosenImages.some(file => !product.images.includes(file))) throw problem('BAD_IMAGE', 'Ảnh được chọn không thuộc hồ sơ.');
      const custom = { scriptPrompt: text(body.scriptPrompt, 12000), rules: text(body.rules, 12000),
        videoModel: text(body.videoModel), images: chosenImages, noCharacter: Boolean(body.noCharacter) };
      if (body.resolution !== undefined && text(body.resolution)) custom.resolution = text(body.resolution);
      if (body.aspect) {
        if (!['9:16', '16:9', '1:1'].includes(body.aspect)) throw problem('ASPECT', 'Chọn tỷ lệ video hợp lệ.');
        custom.aspect = body.aspect;
      }
      if (body.duration) custom.duration = number(body.duration, 1, 120, 'Thời lượng');
      let script;
      if (body.script) script = validateScript(body.script);
      if (body.character && !custom.noCharacter) custom.character = asset(body.character);
      else if (body.characterFile && body.characterFile === base?.inputs?.character) custom.character = body.characterFile;
      const selected = templateId || (script && base?.inputs?.templateId) || undefined;
      const options = { custom, ...(selected ? { templateId: selected } : {}), ...(script ? { script } : {}) };
      if (body.resumeId) {
        const waiting = lookup(state.jobs.filter(job => job.productId === product.id), body.resumeId, 'Phiên bản');
        if (status(waiting, product) !== 'missingTemplate') throw problem('JOB_STATE', 'Phiên bản này không chờ prompt.');
        Object.assign(waiting, options, { step: script ? 'submit' : 'script' });
      } else newJob(product, options);
    }
  } else if ((match = path.match(/^\/api\/jobs\/([^/]+)\/(retry|content|resend)$/))) {
    const job = lookup(state.jobs, match[1], 'Phiên bản');
    if (match[2] === 'content') {
      if (!job.script) throw problem('NO_SCRIPT', 'Chưa có kịch bản để chỉnh.');
      const script = validateScript({ ...job.script, caption: body.caption, hashtags: body.hashtags, cta: body.cta });
      const posted = webUrl(body.posted);
      // Keep the generated script immutable for receipts and video retries.
      job.content = { caption: script.caption, hashtags: script.hashtags, cta: script.cta };
      job.posted = posted;
    } else {
      if (!job.issue) throw problem('JOB_STATE', 'Phiên bản này chưa cần thử lại.');
      if (job.issue.code === 'VIDEO_FAILED') throw problem('VIDEO_FAILED', 'Tạo phiên bản mới sau khi kiểm tra lỗi của tác vụ cũ.');
      if (match[2] === 'resend') {
        if (job.step !== 'lookup' || job.issue.code !== 'MAC_RECONCILE' || !job.key) throw problem('JOB_STATE', 'Chưa thể gửi lại yêu cầu này.');
        job.step = 'submit';
      }
      delete job.issue;
      delete job.nextAt;
      delete job.attempts;
      delete job.lookups;
    }
  } else throw problem('NOT_FOUND', 'Không tìm thấy thao tác này.', 404);
  save();
  return { ok: true };
}

function extensionApi(path, input) {
  const lines = store.state.batches.toReversed().flatMap(batch => batch.lines);
  if (path === '/api/extension/claim') {
    const time = Date.now();
    store.state.settings.extensionSeen = new Date(time).toISOString();
    for (const line of lines.filter(entry => entry.stage === 'extracting' && entry.lease <= time)) {
      line.stage = 'queued'; delete line.claim; delete line.lease;
    }
    if (lines.some(line => line.stage === 'extracting')) return {};
    const line = lines.filter(entry => entry.stage === 'queued').at(0);
    if (!line) return {};
    line.stage = 'extracting';
    line.lease = time + 150000;
    line.claim = randomUUID();
    save();
    return { id: line.id, link: line.link, claim: line.claim };
  }
  if (path !== '/api/extension/result') throw problem('NOT_FOUND', 'Không tìm thấy thao tác extension.', 404);
  const line = lineById(input.id);
  if (line.stage !== 'extracting' || line.claim !== input.claim) throw problem('EXPIRED_CLAIM', 'Lượt lấy dữ liệu đã hết hạn.', 409);
  delete line.claim;
  delete line.lease;
  if (input.state === 'login') {
    line.stage = 'login';
    line.detail = 'Đăng nhập trên tab Chrome vừa mở, sau đó bấm Lấy lại trong app.';
  } else if (input.state === 'error') {
    reportLine(line, 'EXTRACT', text(input.message, 400) || 'Không đọc được trang sản phẩm.');
  } else {
    try { acceptProduct(line, input); } catch (error) {
      reportLine(line, error.status ? error.code : 'EXTRACT_SAVE', error.status ? error.message : 'Không lưu được dữ liệu sản phẩm trên máy.');
    }
  }
  save();
  return { ok: true };
}

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 70 * 1024 * 1024) throw problem('PAYLOAD', 'Dữ liệu quá lớn. Tải ảnh lên theo nhóm nhỏ.', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* Consistent error for invalid JSON. */ }
  throw problem('JSON', 'Dữ liệu gửi lên không hợp lệ.');
}

function send(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function staticFile(response, path) {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats?.isFile()) throw problem('NOT_FOUND', 'Tệp không còn trên máy.', 404);
  response.writeHead(200, { 'Content-Type': mime[path.split('.').at(-1)] || 'application/octet-stream', 'Content-Length': stats.size });
  const stream = createReadStream(path);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; frame-src https://drive.google.com");
  try {
    if (request.headers.host !== appHost) throw problem('HOST', 'Mở app tại ' + origin + '.', 403);
    const url = new URL(request.url, origin);
    const path = url.pathname;
    const method = request.method;
    if (path.startsWith('/api/extension/')) {
      const sender = request.headers.origin;
      if (sender && !/^chrome-extension:\/\/[a-p]{32}$/.test(sender)) throw problem('ORIGIN', 'Nguồn gửi không hợp lệ.', 403);
      if (sender) response.setHeader('Access-Control-Allow-Origin', sender);
      response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Extension-Key');
      if (method === 'OPTIONS') { response.writeHead(204); return response.end(); }
      if (method !== 'POST' || !sameKey(request.headers['x-extension-key'], store.state.settings.extensionKey)) throw problem('EXTENSION_KEY', 'Mã kết nối extension chưa đúng.', 403);
      return send(response, 200, extensionApi(path, await bodyOf(request)));
    }
    if (path.startsWith('/api/')) {
      if (request.headers['x-local-app'] !== '1' || (request.headers.origin && request.headers.origin !== origin)) throw problem('ORIGIN', 'Nguồn gửi không hợp lệ.', 403);
      const body = method === 'POST' ? await bodyOf(request) : {};
      return send(response, 200, await api(path, method, body));
    }
    if (path === '/oauth/google/callback' && method === 'GET') {
      try {
        await finishGoogle(url.searchParams);
        resumeAfterSetup(['GOOGLE_CONNECT', 'GOOGLE_AUTH']);
        save();
        response.writeHead(303, { Location: '/#settings' });
      } catch (error) {
        diagnostic(error.code || 'GOOGLE_AUTH', error.status ? error.message : 'Không kết nối được với Google.', { step: 'oauth' });
        save();
        response.writeHead(303, { Location: '/#errors' });
      }
      return response.end();
    }
    if (method !== 'GET') throw problem('NOT_FOUND', 'Không tìm thấy trang.', 404);
    if (path === '/') return staticFile(response, resolve(root, 'web', 'index.html'));
    if (['/styles.css', '/app.js'].includes(path)) return staticFile(response, resolve(root, 'web', path.slice(1)));
    if (/^\/assets\/[0-9a-f-]{36}\.(png|jpeg|webp|gif)$/.test(path)) return staticFile(response, resolve(store.dir, path.slice(1)));
    throw problem('NOT_FOUND', 'Không tìm thấy trang.', 404);
  } catch (error) {
    if (response.headersSent) return response.destroy();
    if (!error.status && store.state) {
      diagnostic('APP', 'App gặp lỗi khi xử lý yêu cầu. Kiểm tra ứng dụng đang có quyền ghi dữ liệu.', { step: 'server' });
      try { save(); } catch { /* The data directory itself may be unavailable. */ }
    }
    send(response, error.status || 500, { code: error.status ? error.code : 'APP', message: error.status ? error.message : 'App gặp lỗi. Mở Báo lỗi để xem chi tiết.' });
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Cổng 8765 đang được dùng. Kiểm tra app đã mở trong cửa sổ khác.' : 'Không thể mở app: ' + error.code);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  try {
    openStore(process.env.AFFILIATE_DATA_DIR || resolve(root, 'data'));
    setInterval(tick, 700).unref();
    console.log('Affiliate Video Local: ' + origin);
  } catch (error) {
    console.error('Không mở được thư mục dữ liệu: ' + (error.code || error.name));
    server.close();
    process.exitCode = 1;
  }
});
