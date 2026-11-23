import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { problem } from './products.mjs';
import { save, store } from './store.mjs';

export const origin = 'http://127.0.0.1:8765';
export const oauthRedirect = origin + '/oauth/google/callback';

export async function request(url, options = {}, timeout = 30000) {
  return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) });
}

async function json(response) {
  try { return await response.json(); } catch { return {}; }
}

export function macUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && /^\/(?:muse\/|chatgpt\/|gemini\/)?v1\/?$/.test(url.pathname)
      && !url.username && !url.password && !url.search && !url.hash) return url.href.replace(/\/$/, '');
  } catch { /* Show a consistent setting error below. */ }
  throw problem('MAC_URL', 'Nhập địa chỉ mac2API trên cùng máy, ví dụ http://127.0.0.1:18610/v1.');
}

export function macConfig() {
  const { macBase, macKey } = store.state.settings;
  if (!macKey) throw problem('MAC_KEY', 'Thêm khóa mac2API m2c_… trong Cài đặt.');
  return { macBase, macKey };
}

export async function mac(path, { method = 'GET', body, key, config = macConfig() } = {}) {
  let response;
  try {
    response = await request(config.macBase + path, {
      method, headers: { Authorization: 'Bearer ' + config.macKey, ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, method === 'POST' && path === '/chat/completions' ? 180000 : 30000);
  } catch {
    throw Object.assign(problem('MAC_NETWORK', 'Không nhận được phản hồi từ mac2API. Kiểm tra mac2API đang chạy và địa chỉ trong Cài đặt.', 503), { transient: true });
  }
  const data = await json(response);
  if (!response.ok) {
    const code = data.error?.code || data.code;
    const suffix = typeof code === 'string' && /^[A-Z0-9_]{1,60}$/.test(code) ? ' (' + code + ')' : '';
    const messages = { 401: 'Khóa mac2API không hợp lệ hoặc đã thu hồi.', 403: 'Khóa mac2API chưa có quyền cho model hoặc tác vụ này.',
      404: 'mac2API chưa tìm thấy tác vụ hoặc endpoint.', 409: 'mac2API báo xung đột yêu cầu.', 429: 'Hàng đợi mac2API đang bận.' };
    throw Object.assign(problem('MAC_' + response.status, (messages[response.status] || 'mac2API báo lỗi HTTP ' + response.status + '.') + suffix, response.status),
      { transient: response.status === 429 || response.status >= 500, retry: Number(response.headers.get('Retry-After')) || 0 });
  }
  return data;
}

export async function videoPayload(job) {
  const inputs = job.inputs;
  const images = await Promise.all(inputs.images.map(async file => {
    const bytes = await readFile(resolve(store.dir, 'assets', file));
    return 'data:image/' + file.split('.').at(-1) + ';base64,' + bytes.toString('base64');
  }));
  return {
    model: inputs.videoModel, prompt: [
      inputs.rules, 'Bắt buộc: video review tiếng Việt, không hiển thị hoặc nói giá, mức giảm hay mã giảm giá.',
      'Kịch bản đã chọn:', JSON.stringify(job.script),
    ].join('\n'), images, aspect_ratio: inputs.aspect, duration: inputs.duration,
    ...(inputs.resolution ? { resolution: inputs.resolution } : {}),
  };
}

export async function fetchVideo(job, config = macConfig()) {
  const base = new URL(config.macBase);
  const result = new URL(job.result, config.macBase + '/');
  if (result.origin !== base.origin || result.username || result.password) throw problem('VIDEO_URL', 'Địa chỉ tệp trả về khác địa chỉ mac2API. Kiểm tra URL máy chủ trong nhật ký mac2API.');
  const response = await request(result, { headers: { Authorization: 'Bearer ' + config.macKey } }, 300000);
  if (!response.ok || !response.body || /^(?:text\/|application\/json)/i.test(response.headers.get('content-type') || '')) throw problem('VIDEO_DOWNLOAD', 'Chưa tải được MP4 từ mac2API. Thử lại để lấy đường dẫn mới.', 502);
  const file = resolve(store.dir, 'video', job.id + '.mp4');
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(file + '.tmp'));
    if ((await stat(file + '.tmp')).size === 0) throw problem('VIDEO_EMPTY', 'mac2API trả tệp video trống.');
    await rename(file + '.tmp', file);
  } finally {
    await rm(file + '.tmp', { force: true });
  }
  return file;
}

export function startGoogle() {
  const settings = store.state.settings;
  if (!settings.googleClient || !settings.googleSecret) throw problem('GOOGLE_CONFIG', 'Điền OAuth Client ID và Client Secret trong Cài đặt.');
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  settings.oauth = { state, verifier, created: Date.now() };
  save();
  const options = new URLSearchParams({
    client_id: settings.googleClient, redirect_uri: oauthRedirect, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file', access_type: 'offline', prompt: 'consent',
    state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + options;
}

async function googleToken(params) {
  const settings = store.state.settings;
  const response = await request('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ client_id: settings.googleClient, client_secret: settings.googleSecret, ...params }),
  });
  const token = await json(response);
  if (!response.ok) throw problem('GOOGLE_AUTH', 'Google chưa xác nhận quyền truy cập. Kiểm tra OAuth Client và kết nối lại trong Cài đặt.', 403);
  return { ...token, expires: Date.now() + (Number(token.expires_in) || 3600) * 1000 };
}

export async function finishGoogle(query) {
  const settings = store.state.settings;
  const session = settings.oauth;
  if (!session || session.state !== query.get('state') || Date.now() - session.created > 600000) {
    throw problem('GOOGLE_STATE', 'Phiên kết nối Google đã hết hạn. Bấm Kết nối Google Drive để thử lại.');
  }
  delete settings.oauth;
  save();
  if (!query.get('code')) throw problem('GOOGLE_DENIED', 'Chưa cấp quyền Google Drive.');
  const token = await googleToken({ grant_type: 'authorization_code', code: query.get('code'), redirect_uri: oauthRedirect, code_verifier: session.verifier });
  if (!token.refresh_token) throw problem('GOOGLE_REFRESH', 'Google chưa cấp quyền truy cập lâu dài. Hãy kết nối lại.');
  settings.googleToken = token;
  save();
}

async function drive(path, options = {}) {
  const settings = store.state.settings;
  const token = settings.googleToken;
  if (!token?.refresh_token) throw problem('GOOGLE_CONNECT', 'Kết nối Google Drive trong Cài đặt rồi thử lại bước lưu.', 403);
  if (Date.now() + 60000 >= token.expires) {
    try {
      const refreshed = await googleToken({ grant_type: 'refresh_token', refresh_token: token.refresh_token });
      settings.googleToken = { ...token, ...refreshed };
      save();
    } catch (error) {
      if (error.code === 'GOOGLE_AUTH') { delete settings.googleToken; save(); }
      throw error;
    }
  }
  const response = await request('https://www.googleapis.com' + path, {
    ...options, headers: { Authorization: 'Bearer ' + settings.googleToken.access_token, ...options.headers },
  });
  if (!response.ok && response.status !== 404) throw driveError(response.status);
  return response;
}

function driveError(status) {
  return problem('DRIVE_' + status, status === 401 || status === 403
    ? 'Google Drive từ chối yêu cầu. Kiểm tra quyền ghi, dung lượng và kết nối lại nếu cần.'
    : 'Google Drive chưa lưu được tệp (HTTP ' + status + '). Bạn có thể thử lại riêng bước lưu.', 502);
}

// Cấp ID trước khi ghi để có thể đối chiếu chính xác, kể cả khi Drive đã lưu nhưng phản hồi bị mất.
async function driveId(owner, field) {
  if (owner[field]) return owner[field];
  const response = await drive('/drive/v3/files/generateIds?count=1&space=drive');
  const data = await json(response);
  if (!data.ids?.[0]) throw problem('DRIVE_ID', 'Google Drive chưa cấp được mã tệp.');
  owner[field] = data.ids[0];
  save();
  return owner[field];
}

async function metadata(id) {
  const response = await drive('/drive/v3/files/' + encodeURIComponent(id) + '?fields=id,trashed,mimeType,webViewLink');
  if (response.status === 404) return null;
  const data = await json(response);
  if (data.trashed) throw problem('DRIVE_TRASH', 'Tệp hoặc thư mục đang trong thùng rác Drive. Hãy khôi phục rồi thử lại.');
  return data;
}

async function folder(owner, field, name, parent) {
  const id = await driveId(owner, field);
  if (!await metadata(id)) {
    const response = await drive('/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }),
    });
    if (!response.ok) throw driveError(response.status);
  }
  return id;
}

export async function saveVideoToDrive(job, product, file) {
  const settings = store.state.settings;
  // Mã thư mục đã lưu trong hồ sơ được ưu tiên khi lưu thêm phiên bản.
  const parent = product.driveFolder || await folder(product, 'pendingFolder', product.name + ' · ' + product.id.slice(0, 8),
    await folder(settings, 'driveRoot', settings.googleRootName));
  if (!product.driveFolder) {
    product.driveFolder = parent;
    save();
  }
  const id = await driveId(job, 'driveUploadId');
  const existing = await metadata(id);
  if (existing) return existing;
  const length = (await stat(file)).size;
  const response = await drive('/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(length) },
    body: JSON.stringify({ id, name: 'Video ' + String(job.number).padStart(2, '0') + '.mp4', mimeType: 'video/mp4', parents: [parent] }),
  });
  const location = response.headers.get('location');
  if (!response.ok || !location || new URL(location).origin !== 'https://www.googleapis.com') throw driveError(response.status);
  const upload = await request(location, { method: 'PUT', duplex: 'half',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(length) }, body: createReadStream(file) }, 300000);
  if (!upload.ok) throw driveError(upload.status);
  const saved = await json(upload);
  if (saved.id !== id) throw problem('DRIVE_VERIFY', 'Chưa xác nhận được video trên Google Drive. Hãy thử lại bước lưu.');
  return saved;
}
