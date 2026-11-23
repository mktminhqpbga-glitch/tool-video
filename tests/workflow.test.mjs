import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { identity } from '../server/products.mjs';
import { productData, validateScript } from '../server/workflow.mjs';

const local = 'http://127.0.0.1:8765';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1QAAAAASUVORK5CYII=';
const videoBytes = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
const script = { scenes: [{ visual: 'Tay cầm sản phẩm', voice: 'Quan sát phần tay cầm', overlay: 'Tay cầm', seconds: 8 }],
  caption: 'Xem cách cầm sản phẩm.', hashtags: ['#review'], cta: 'Xem chi tiết' };

test('product identity and script price rules', () => {
  assert.equal(identity('https://shopee.vn/Binh-i.123.456?x=1').key, 'shopee:123:456');
  assert.equal(identity('https://shopee.vn/product/123/456').key, 'shopee:123:456');
  assert.equal(identity('https://www.tiktok.com/shop/pdp/title/123456', '123456').key, 'tiktok:123456');
  assert.equal(identity('https://shopee.vn.example.com/product/123/456'), null);
  assert.equal(productData({ name: 'Bình', description: 'Giá chỉ 90.000₫. Có nắp.' }).description, 'Có nắp.');
  assert.throws(() => validateScript({ ...script, caption: 'Giá chỉ 80k' }), /giá/);
  assert.deepEqual(validateScript(script), script);
});

test('batch, image recovery, mac2API reconciliation and Drive retry', { timeout: 65000 }, async t => {
  const folder = await mkdtemp(resolve(tmpdir(), 'affiliate-video-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  let group;
  let chatCalls = 0;
  let videoCalls = 0;
  let lookupCalls = 0;
  let serial = 0;
  let uploads = 0;
  let failUpload = true;
  const tasks = new Map();
  const driveFiles = new Map();
  const maximumImages = [];
  const input = async request => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  const send = (response, code, data) => {
    response.writeHead(code, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  };
  const fake = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, local);
    const method = request.method;
    if (pathname === '/v1/capabilities') return send(response, 200, { models: [{ id: 'muse/video', maxReferences: 6 }] });
    if (pathname === '/v1/chat/completions') {
      const body = JSON.parse(await input(request));
      chatCalls++;
      assert.equal(request.headers.authorization, 'Bearer m2c_test_only');
      assert.ok(!body.messages.at(-1).content.includes('120.000₫'));
      const content = body.messages[0].content.startsWith('Phân nhóm') ? { id: group } : script;
      return send(response, 200, { choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    if (pathname === '/v1/videos' && method === 'POST') {
      const body = JSON.parse(await input(request));
      maximumImages.push(body.images.length);
      assert.equal(body.model, 'muse/video');
      assert.match(body.prompt, /không hiển thị hoặc nói giá/);
      videoCalls++;
      const key = request.headers['idempotency-key'];
      assert.match(key, /^[0-9a-f-]{36}$/);
      tasks.set(key, { id: 'task_' + videoCalls });
      if (videoCalls === 1) return response.destroy();
      return send(response, 200, tasks.get(key));
    }
    if (pathname === '/v1/tasks/by-request') {
      lookupCalls++;
      return send(response, 200, tasks.get(request.headers['idempotency-key']));
    }
    if (/^\/v1\/videos\/task_\d+$/.test(pathname)) return send(response, 200, { status: 'completed', result: { url: fakeOrigin + '/video/file.mp4' } });
    if (pathname === '/video/file.mp4') {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      return response.end(videoBytes);
    }
    if (pathname === '/token') return send(response, 200, { access_token: 'mock-access', refresh_token: 'mock-refresh', expires_in: 3600 });
    if (pathname === '/drive/v3/files/generateIds') return send(response, 200, { ids: ['file_' + ++serial] });
    if (pathname === '/drive/v3/files' && method === 'POST') {
      const data = JSON.parse(await input(request));
      driveFiles.set(data.id, data);
      return send(response, 200, { id: data.id });
    }
    if (pathname.startsWith('/drive/v3/files/')) {
      const item = driveFiles.get(pathname.split('/').at(-1));
      return send(response, item ? 200 : 404, item || {});
    }
    if (pathname === '/upload/drive/v3/files') {
      const data = JSON.parse(await input(request));
      response.writeHead(200, { Location: 'https://www.googleapis.com/test-upload/' + data.id });
      return response.end();
    }
    if (pathname.startsWith('/test-upload/')) {
      const bytes = await input(request);
      assert.deepEqual(bytes, videoBytes);
      uploads++;
      if (failUpload) {
        failUpload = false;
        return send(response, 500, {});
      }
      const id = pathname.split('/').at(-1);
      driveFiles.set(id, { id, mimeType: 'video/mp4' });
      return send(response, 200, { id });
    }
    return send(response, 404, {});
  });
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  const fakeOrigin = 'http://127.0.0.1:' + fake.address().port;
  t.after(() => { fake.closeAllConnections(); fake.close(); });
  let child;
  async function start() {
    child = spawn(process.execPath, ['--import', './tests/mock-google.mjs', './server/index.mjs'], {
      env: { ...process.env, AFFILIATE_DATA_DIR: folder, TEST_DRIVE_SERVER: fakeOrigin }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await Promise.race([once(child.stdout, 'data').then(([buf]) => buf.toString()), once(child, 'exit').then(() => '')]);
    assert.match(ready, /8765/);
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    }
  }
  t.after(stop);
  await start();
  async function api(path, data, headers = { 'X-Local-App': '1' }) {
    const response = await fetch(local + '/api/' + path, { method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  async function until(predicate) {
    for (let index = 0; index < 130; index++) {
      const state = await api('state');
      if (predicate(state)) return state;
      await delay(250);
    }
    assert.fail('State not reached: ' + JSON.stringify(await api('state')).slice(-5500));
  }
  await api('settings', { macBase: fakeOrigin + '/v1', macKey: 'm2c_test_only', googleClient: 'test', googleSecret: 'test-value', pollSeconds: 5 });
  assert.equal((await api('mac/check', {})).models[0].id, 'muse/video');
  const oauth = new URL((await api('google/start', {})).url).searchParams;
  assert.equal(oauth.get('code_challenge_method'), 'S256');
  const callback = await fetch(local + '/oauth/google/callback?code=test&state=' + oauth.get('state'), { redirect: 'manual' });
  assert.equal(callback.headers.get('location'), '/#settings');
  await api('templates', { name: 'Bình', group: 'Bình nước', criteria: 'Đồ đựng nước', script: 'Review bình', rules: 'Giữ nguyên màu bao bì', character: image });
  group = (await api('state')).templates.at(-1).id;
  const key = (await api('state')).settings.extensionKey;
  const extension = (path, body) => api('extension/' + path, body, { 'X-Extension-Key': key });
  const { id } = await api('batches', {
    links: ['https://shopee.vn/product/8/22', 'https://shopee.vn/product/8/22', 'https://shopee.vn/Binh-i.8.22?tag=old', 'https://www.tiktok.com/shop/pdp/123456', 'wrong'].join('\n'),
  });
  const first = await extension('claim', {});
  await extension('result', { ...first, state: 'ok', url: first.link, name: 'Bình nước', description: 'Giá chỉ 120.000₫. Có nắp.', images: [image] });
  const second = await extension('claim', {});
  await extension('result', { ...second, state: 'ok', url: second.link, name: 'Bình nước', images: [image] });
  const third = await extension('claim', {});
  await extension('result', { ...third, state: 'ok', url: third.link, name: 'Bình khác', images: [] });
  const waiting = await until(value => value.jobs.some(job => job.stage === 'missingImages'));
  const batch = waiting.batches.find(item => item.id === id);
  assert.deepEqual(batch.lines.map(line => line.stage), ['linked', 'duplicate', 'duplicate', 'linked', 'invalid']);
  assert.equal(batch.lines[0].productId, batch.lines[2].productId);
  assert.equal(waiting.products.length, 2);
  const productId = batch.lines[0].productId;
  const missingId = batch.lines[3].productId;
  const reviewing = await until(value => value.jobs.some(job => job.productId === productId && job.issue?.code === 'DRIVE_500'));
  const job = reviewing.jobs.find(item => item.productId === productId);
  assert.equal(job.inputs.group, 'Bình nước');
  assert.equal(lookupCalls, 1);
  await stop();
  await start();
  await api('jobs/' + job.id + '/retry', {});
  await api('products/' + missingId + '/images', { images: [image] });
  await until(value => value.jobs.filter(item => item.stage === 'ready').length === 2);
  assert.equal(videoCalls, 2);
  await api('products/' + productId + '/version', { baseId: job.id, script, noCharacter: 'yes' });
  const done = await until(value => value.jobs.filter(item => item.stage === 'ready').length === 3);
  assert.equal(videoCalls, 3);
  assert.equal(chatCalls, 4);
  assert.deepEqual(maximumImages, [2, 2, 1]);
  assert.equal(uploads, 4);
  assert.equal(driveFiles.size, 6);
  assert.equal(done.jobs.filter(item => item.productId === productId).length, 2);
  assert.equal((await api('diagnostics')).errors[0].code, 'DRIVE_500');
  const persisted = JSON.parse(await readFile(resolve(folder, 'state.json'), 'utf8'));
  assert.notEqual(persisted.jobs[0].driveFile, persisted.jobs[2].driveFile);
});
