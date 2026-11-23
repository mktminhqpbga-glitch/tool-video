import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const defaults = {
  macBase: 'http://127.0.0.1:18610/v1',
  textModel: 'muse/text', videoModel: 'muse/video',
  aspect: '9:16', duration: 15, resolution: '', maxImages: 6,
  parallelVideos: 2, pollSeconds: 12,
  googleClient: '', googleRootName: 'Video Affiliate',
};
export const store = { state: null, dir: null };
export const now = () => new Date().toISOString();

export function openStore(directory) {
  store.dir = resolve(directory);
  mkdirSync(store.dir, { recursive: true, mode: 0o700 });
  mkdirSync(resolve(store.dir, 'assets'), { recursive: true });
  mkdirSync(resolve(store.dir, 'video'), { recursive: true });
  try {
    store.state = JSON.parse(readFileSync(resolve(store.dir, 'state.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const id = randomUUID();
    store.state = {
      settings: { ...defaults, extensionKey: randomBytes(24).toString('hex') },
      templates: [{
        id, name: 'Review sản phẩm', group: '', criteria: '', revision: 1,
        script: 'Viết review tiếng Việt dựa trên dữ liệu có sẵn. Mở đầu bằng một điểm đáng chú ý, giới thiệu thiết kế và cách dùng, kết thúc bằng lời mời xem sản phẩm. Chỉ nêu chi tiết có căn cứ.',
        rules: 'Giữ đúng hình dáng, màu sắc, nhãn và bao bì sản phẩm. Dùng tiếng Việt rõ ràng. Không giả vờ đã dùng thử sản phẩm.',
        character: null,
      }],
      defaultTemplate: id, batches: [], products: [], jobs: [], errors: [],
    };
    save();
  }
}

// Một backend duy nhất, ghi đồng bộ và đổi tên nguyên tử để giữ tiến độ sau khi tắt máy.
export function save() {
  const file = resolve(store.dir, 'state.json');
  writeFileSync(file + '.tmp', JSON.stringify(store.state, null, 2), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

export function diagnostic(code, message, context = {}) {
  const entry = { id: randomUUID(), time: now(), code, message, ...context };
  store.state.errors.unshift(entry);
  store.state.errors.splice(250);
  return entry;
}

export function publicSettings() {
  const { macKey, googleSecret, googleToken, extensionKey, oauth, ...settings } = store.state.settings;
  return { ...settings, hasMacKey: Boolean(macKey), hasGoogleSecret: Boolean(googleSecret),
    googleConnected: Boolean(googleToken?.refresh_token), extensionKey };
}
