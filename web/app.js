'use strict';

const main = document.querySelector('#main');
const notice = document.querySelector('#notice');
let state;
let activePage = '';
let dirty = false;
let lastView = '';
let noticeTimer;
let loading = false;

const stages = {
  queued: 'Chờ lấy dữ liệu', extracting: 'Đang lấy dữ liệu', invalid: 'Link lỗi', duplicate: 'Đã có hồ sơ',
  extractError: 'Lỗi lấy dữ liệu', login: 'Cần đăng nhập', missingDetails: 'Thiếu thông tin', missingImages: 'Thiếu ảnh sản phẩm',
  missingTemplate: 'Chờ chọn prompt', classify: 'Phân nhóm', script: 'Viết kịch bản', submit: 'Chờ tạo video',
  lookup: 'Đối chiếu tác vụ', poll: 'Đang tạo video', download: 'Đang tải video', upload: 'Đang lưu Drive',
  ready: 'Sẵn sàng tải', error: 'Cần xử lý',
};
const warns = new Set(['login', 'missingDetails', 'missingImages', 'missingTemplate', 'lookup']);
const errors = new Set(['invalid', 'extractError', 'error']);
const date = value => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const assetUrl = file => '/assets/' + encodeURIComponent(file);

function node(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name.startsWith('on')) element.addEventListener(name.slice(2), value);
    else if (name === 'class') element.className = value;
    else if (['value', 'checked', 'disabled', 'selected'].includes(name)) element[name] = value;
    else if (value !== null && value !== undefined && value !== false) element.setAttribute(name, value === true ? '' : value);
  }
  element.append(...children.flat(Infinity).filter(value => value != null && value !== false));
  return element;
}

function button(label, handler, primary = false) {
  return node('button', { type: 'button', class: primary ? 'primary' : '', onclick: event => perform(event.currentTarget, handler) }, label);
}
function link(label, href, external = false, styled = false) {
  return node('a', { href, class: styled ? 'button' : '', ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, label);
}
const row = (...children) => node('div', { class: 'row' }, ...children);
const grid = (...children) => node('div', { class: 'grid' }, ...children);
const panel = (...children) => node('section', { class: 'panel' }, ...children);
const muted = value => node('p', { class: 'muted small' }, value);
const heading = (title, description) => [node('h1', {}, title), description && node('p', { class: 'lead' }, description)];
const badge = stage => node('span', { class: 'status ' + (errors.has(stage) ? 'bad' : warns.has(stage) ? 'warn' : '') }, stages[stage] || stage || 'Đang chờ');
const message = (value, bad = false) => node('p', { class: 'message' + (bad ? ' bad' : '') }, value);
const detail = (label, ...items) => node('details', {}, node('summary', {}, label), ...items);
const captionOf = script => [script.caption, script.cta, script.hashtags.join(' ')].filter(Boolean).join('\n\n');
const formData = form => Object.fromEntries(new FormData(form));
const getJob = id => state.jobs.find(job => job.id === id);

function field(label, name, value = '', options = {}) {
  const { type = 'text', hint, tall, choices, ...attributes } = options;
  let input;
  if (type === 'textarea') input = node('textarea', { name, class: tall ? 'tall' : '', value, ...attributes });
  else if (choices) input = node('select', { name, ...attributes }, choices.map(([key, title]) => node('option', { value: key, selected: key === value }, title)));
  else input = node('input', { type, name, value, ...attributes });
  return node('label', { class: 'field' }, node('span', {}, label), input, hint && node('small', {}, hint));
}
function checkbox(label, name, checked = false, value = 'yes') {
  return node('label', { class: 'checkbox' }, node('input', { type: 'checkbox', name, value, checked }), label);
}
function form(handler, ...fields) {
  return node('form', { onsubmit: event => {
    event.preventDefault();
    const target = event.currentTarget;
    void perform(target.querySelector('[type=submit]'), () => handler(target));
  } }, ...fields);
}
const submit = label => node('button', { type: 'submit', class: 'primary' }, label);

async function api(path, data) {
  const response = await fetch('/api/' + path, {
    method: data === undefined ? 'GET' : 'POST', headers: { 'X-Local-App': '1', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Yêu cầu chưa hoàn tất.');
  return result;
}
function announce(text, bad = false) {
  notice.className = 'notice' + (bad ? ' bad' : '');
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, bad ? 11000 : 4500);
}
async function perform(control, action) {
  if (control.disabled) return;
  control.disabled = true;
  try { await action(); }
  catch (error) { announce(error.message || 'App gặp lỗi. Hãy thử lại.', true); }
  finally { control.disabled = false; }
}
async function commit(path, data, feedback, destination) {
  await api(path, data);
  dirty = false;
  if (destination) location.hash = destination;
  await refresh(true);
  announce(feedback);
}
async function copy(value) {
  await navigator.clipboard.writeText(value);
  announce('Đã sao chép.');
}
async function files(input, max = 8) {
  const chosen = [...input.files];
  if (chosen.length > max) throw new Error('Chỉ chọn tối đa ' + max + ' ảnh mỗi lần.');
  if (chosen.reduce((sum, item) => sum + item.size, 0) > 48 * 1024 * 1024) throw new Error('Tổng ảnh quá lớn. Hãy tải lên theo nhóm nhỏ hơn.');
  return Promise.all(chosen.map(file => new Promise((resolve, reject) => {
    if (file.size > 10 * 1024 * 1024) return reject(new Error('Mỗi ảnh tối đa 10 MB.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Chưa đọc được ảnh ' + file.name));
    reader.onload = async () => {
      try {
        const image = await createImageBitmap(file);
        image.close();
        resolve(reader.result);
      } catch { reject(new Error('Ảnh không mở được: ' + file.name)); }
    };
    reader.readAsDataURL(file);
  })));
}
const imageField = (label, name, multiple = false) => field(label, name, '', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple });
const aspectChoices = [['', 'Theo mặc định'], ['9:16', '9:16 · Dọc'], ['16:9', '16:9 · Ngang'], ['1:1', '1:1 · Vuông']];

function createScreen() {
  return [
    ...heading('Tạo video', 'Dán một hoặc nhiều link Shopee, TikTok Shop. Mỗi sản phẩm mới tự tạo một video.'),
    panel(form(async target => {
      const result = await api('batches', formData(target));
      dirty = false;
      location.hash = 'queue/' + result.id;
      await refresh(true);
      announce('Đã đưa danh sách vào hàng đợi.');
    }, field('Link sản phẩm', 'links', '', { type: 'textarea', tall: true, required: true, placeholder: 'https://shopee.vn/…\nhttps://www.tiktok.com/…', hint: 'Mỗi dòng một link, tối đa 100 link.' }),
    row(submit('Xử lý tất cả'), link('Xem tiến độ', '#queue', false, true)))),
    !state.settings.hasMacKey && message('Thêm khóa mac2API trong Cài đặt để app tạo kịch bản và video.'),
    !state.settings.googleConnected && message('Kết nối Google Drive trong Cài đặt để lưu MP4.'),
    panel(node('h2', {}, 'Đợt nhập gần đây'), state.batches.length ? node('div', { class: 'stack' },
      state.batches.slice(0, 5).map(batch => link(date(batch.created) + ' · ' + batch.lines.length + ' link', '#queue/' + batch.id))) : muted('Chưa có đợt nhập.')),
  ];
}

function queueScreen(id) {
  const batch = state.batches.find(item => item.id === id) || state.batches[0];
  if (!batch) return [...heading('Tiến độ'), panel(muted('Chưa có đợt nhập.'), link('Tạo video', '#create', false, true))];
  const final = new Set(['ready', 'duplicate']);
  const attention = line => errors.has(line.stage) || line.stage === 'login' || (line.stage !== 'duplicate' && (errors.has(line.current) || ['missingImages', 'missingDetails', 'missingTemplate'].includes(line.current)));
  const duplicates = batch.lines.filter(line => line.stage === 'duplicate').length;
  const ready = batch.lines.filter(line => line.stage !== 'duplicate' && line.current === 'ready').length;
  const flagged = batch.lines.filter(attention).length;
  const working = batch.lines.filter(line => !final.has(line.current || line.stage) && line.stage !== 'duplicate' && !attention(line)).length;
  return [
    ...heading('Tiến độ', 'Các dòng chờ bổ sung ảnh hoặc gặp lỗi được xử lý riêng.'),
    panel(field('Đợt nhập', 'batch', batch.id, {
      choices: state.batches.map(item => [item.id, date(item.created) + ' · ' + item.lines.length + ' link']),
      onchange: event => { location.hash = 'queue/' + event.target.value; },
    }), node('div', { class: 'row stats' }, [batch.lines.length + ' link', working + ' đang xử lý', ready + ' sẵn sàng', duplicates + ' trùng', flagged + ' cần xử lý'].map(label => node('span', { class: 'status' }, label))),
    node('div', { class: 'table-wrap' }, node('table', {}, node('thead', {}, node('tr', {}, ['Dòng', 'Link sản phẩm', 'Trạng thái', 'Thao tác'].map(name => node('th', { scope: 'col' }, name)))),
      node('tbody', {}, batch.lines.map((line, index) => node('tr', {}, node('td', {}, index + 1),
        node('td', { class: 'linkcell' }, line.stage === 'invalid' ? line.link : link(line.link, line.link, true), line.detail && muted(line.detail)),
        node('td', {}, badge(line.stage === 'linked' ? line.current : line.stage), line.stage === 'duplicate' && line.current && muted(stages[line.current] || '')),
        node('td', {}, line.productId && link('Mở hồ sơ', '#product/' + line.productId, false, true),
          ['login', 'extractError'].includes(line.stage) && row(
            button('Lấy lại', () => commit('lines/' + line.id + '/retry', {}, 'Đã đưa link vào hàng đợi.')),
            link('Nhập thủ công', '#manual/' + line.id, false, true))))))))),
  ];
}

function manualScreen(id) {
  const line = state.batches.flatMap(batch => batch.lines).find(item => item.id === id);
  if (!line) return heading('Không tìm thấy link');
  return [...heading('Nhập sản phẩm thủ công', 'Dùng link sản phẩm trực tiếp của cùng sàn. App sẽ tự xử lý sau khi đủ tên và ảnh.'),
    panel(form(async target => {
      const data = formData(target);
      data.images = await files(target.elements.images);
      await commit('lines/' + id + '/manual', data, 'Đã lưu thông tin sản phẩm.', 'queue');
    }, field('Link sản phẩm trực tiếp', 'url', line.link, { type: 'url', required: true }),
    field('Tên sản phẩm', 'name', '', { required: true }), field('Mô tả', 'description', '', { type: 'textarea' }),
    field('Biến thể', 'variant'), imageField('Ảnh sản phẩm', 'images', true), submit('Lưu và tiếp tục')))];
}

function productsScreen() {
  const list = node('div', { class: 'stack' });
  function renderList(query) {
    const matches = state.products.filter(item => [item.name, item.source, item.platform].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    list.replaceChildren(...(matches.length ? matches.map(product => row(link(product.name || 'Hồ sơ chưa có tên', '#product/' + product.id, false, true),
      node('span', { class: 'small muted' }, product.platform === 'shopee' ? 'Shopee' : 'TikTok Shop'), badge(state.jobs.filter(job => job.productId === product.id).at(-1)?.stage)))
      : [muted('Không có hồ sơ phù hợp.')]));
  }
  renderList('');
  return [...heading('Kho hồ sơ', 'Mỗi sản phẩm có một hồ sơ chứa các phiên bản video và content tương ứng.'),
    panel(field('Tìm sản phẩm', 'search', '', { type: 'search', oninput: event => renderList(event.target.value) }), list)];
}

function gallery(files) {
  return node('div', { class: 'gallery' }, files.map((file, index) => node('figure', {},
    node('img', { src: assetUrl(file), alt: 'Ảnh tham chiếu ' + (index + 1), loading: 'lazy' }),
    node('figcaption', {}, index === 0 ? 'Ảnh chính' : 'Ảnh ' + (index + 1)))));
}

function productScreen(id) {
  const product = state.products.find(item => item.id === id);
  if (!product) return heading('Hồ sơ không tồn tại');
  const all = state.jobs.filter(job => job.productId === id).toReversed();
  const update = form(target => commit('products/' + id + '/edit', formData(target), 'Đã lưu hồ sơ.'),
    field('Tên sản phẩm', 'name', product.name, { required: true }), field('Biến thể', 'variant', product.variant),
    field('Mô tả', 'description', product.description, { type: 'textarea' }),
    field('Link affiliate', 'affiliate', product.affiliate, { type: 'url' }), submit('Lưu thông tin'));
  return [
    ...heading(product.name || 'Hồ sơ sản phẩm', product.platform === 'shopee' ? 'Shopee' : 'TikTok Shop'),
    panel(row(link('Link nguồn', product.source, true, true), link('Tạo phiên bản mới', '#version/' + id, false, true),
      product.affiliate && button('Sao chép link affiliate', () => copy(product.affiliate)),
      product.driveFolder && link('Thư mục Drive', 'https://drive.google.com/drive/folders/' + encodeURIComponent(product.driveFolder), true, true)),
    !product.affiliate && muted('Chưa có link affiliate. Bạn có thể thêm trước khi đăng.'),
    product.name ? detail('Chỉnh thông tin và link affiliate', update) : update),
    panel(node('h2', {}, 'Ảnh sản phẩm'), !product.images.length && message('Thiếu ảnh sản phẩm. Tải ảnh lên để app tự tiếp tục.', true),
      gallery(product.images), form(async target => commit('products/' + id + '/images',
        { images: await files(target.elements.images) }, 'Đã lưu ảnh.'), imageField('Tải ảnh lên', 'images', true), submit('Lưu ảnh'))),
    node('h2', {}, 'Phiên bản video'), all.map(job => jobPanel(product, job)),
  ];
}

function preview(job) {
  const box = node('div', {});
  return node('details', { ontoggle: event => {
    if (!event.currentTarget.open || box.childElementCount) return;
    box.append(node('iframe', {
      class: 'video-preview', title: 'Xem trước video ' + job.number,
      src: 'https://drive.google.com/file/d/' + encodeURIComponent(job.driveFile) + '/preview',
      allowfullscreen: true, referrerpolicy: 'no-referrer',
    }), muted('Nếu Drive yêu cầu quyền xem, dùng nút Mở trên Drive.'));
  } }, node('summary', {}, 'Xem trước video'), box);
}

function jobPanel(product, job) {
  const content = job.content || job.script;
  const downloads = job.driveFile && row(
    link('Mở trên Drive', job.driveLink, true, true),
    link('Tải MP4', 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(job.driveFile), true, true),
    content && button('Sao chép content', () => copy(captionOf(content)), true));
  const retry = job.issue && row(
    job.issue.code !== 'VIDEO_FAILED' && button(job.issue.code === 'MAC_RECONCILE' ? 'Tra cứu lại' : 'Thử lại', () => commit('jobs/' + job.id + '/retry', {}, 'Đã đưa phiên bản vào hàng đợi.')),
    job.issue.code === 'MAC_RECONCILE' && button('Gửi lại với cùng mã', () => commit('jobs/' + job.id + '/resend', {}, 'Đã đưa yêu cầu cũ vào hàng đợi.')),
    link('Xem báo lỗi', '#errors', false, true));
  const edit = content && detail('Content và link bài đã đăng',
    form(target => {
      const data = formData(target);
      data.hashtags = data.hashtags.split(/\s+/).filter(Boolean);
      return commit('jobs/' + job.id + '/content', data, 'Đã lưu content.');
    }, field('Caption', 'caption', content.caption, { type: 'textarea', required: true }),
    field('Hashtag, cách nhau bằng dấu cách', 'hashtags', content.hashtags.join(' ')), field('Lời kêu gọi', 'cta', content.cta),
    field('Link bài đã đăng', 'posted', job.posted || '', { type: 'url' }),
    row(submit('Lưu content'), button('Sao chép content', () => copy(captionOf(content))))));
  return panel(
    row(node('h3', {}, 'Video ' + job.number), badge(job.stage), job.stage === 'poll' && Number.isFinite(job.progress) && node('span', { class: 'small muted' }, job.progress + '%')),
    muted(date(job.created) + (job.inputs ? ' · ' + job.inputs.templateName + ' · bản ' + job.inputs.templateRevision : '')),
    job.issue && message(job.issue.message, true), retry,
    job.stage === 'missingTemplate' && link('Chọn prompt để tiếp tục', '#version/' + product.id + '/' + job.id, false, true),
    downloads, job.driveFile && preview(job), edit,
    job.script && detail('Kịch bản đã dùng', job.script.scenes.map((scene, index) =>
      node('div', {}, node('h3', {}, 'Cảnh ' + (index + 1) + (scene.seconds ? ' · ' + scene.seconds + ' giây' : '')),
        node('p', {}, scene.visual), scene.voice && muted('Lời thoại: ' + scene.voice), scene.overlay && muted('Chữ: ' + scene.overlay)))),
    job.inputs && detail('Đầu vào đã dùng', muted(job.inputs.videoModel + ' · ' + job.inputs.aspect + ' · ' + job.inputs.duration + ' giây'),
      gallery(job.inputs.images), node('h3', {}, 'Prompt kịch bản'), node('pre', {}, job.inputs.scriptPrompt),
      node('h3', {}, 'Quy tắc video'), node('pre', {}, job.inputs.rules)),
    job.script && link('Chỉnh sâu và tạo video mới', '#version/' + product.id + '/' + job.id, false, true),
  );
}

function versionScreen(productId, jobId) {
  const product = state.products.find(item => item.id === productId);
  if (!product) return heading('Hồ sơ không tồn tại');
  const base = getJob(jobId);
  const inputs = base?.inputs;
  const waiting = base?.stage === 'missingTemplate';
  const selected = new Set(inputs?.images.filter(file => product.images.includes(file)) || product.images);
  const sceneList = node('div', { class: 'stack' });
  function addScene(scene = {}) {
    const title = node('strong', { class: 'scene-title' });
    const entry = node('fieldset', { class: 'scene' }, node('legend', {}, title),
      field('Mô tả hình ảnh', 'sceneVisual', scene.visual || '', { type: 'textarea' }),
      field('Lời thoại', 'sceneVoice', scene.voice || '', { type: 'textarea' }),
      grid(field('Chữ trên màn hình', 'sceneOverlay', scene.overlay || ''),
        field('Thời lượng cảnh (giây)', 'sceneSeconds', scene.seconds || '', { type: 'number', min: 1, max: 300 })),
      button('Bỏ cảnh này', () => {
        if (sceneList.children.length === 1) throw new Error('Kịch bản cần giữ ít nhất một cảnh.');
        entry.remove();
        labelScenes();
        dirty = true;
      }));
    sceneList.append(entry);
    labelScenes();
  }
  function labelScenes() {
    [...sceneList.querySelectorAll('.scene-title')].forEach((title, index) => { title.textContent = 'Cảnh ' + (index + 1); });
  }
  const originalContent = base?.content || base?.script;
  for (const scene of base?.script?.scenes || []) addScene(scene);
  const editor = base?.script && detail('Chỉnh kịch bản theo từng cảnh',
    checkbox('Dùng kịch bản bên dưới. Bỏ chọn để viết lại theo mẫu prompt.', 'useScript', true),
    sceneList,
    button('Thêm cảnh', () => {
      if (sceneList.children.length >= 30) throw new Error('Một kịch bản có tối đa 30 cảnh.');
      addScene();
      dirty = true;
    }),
    field('Caption', 'scriptCaption', originalContent.caption, { type: 'textarea' }),
    field('Hashtag, cách nhau bằng dấu cách', 'scriptHashtags', originalContent.hashtags.join(' ')),
    field('Lời kêu gọi', 'scriptCta', originalContent.cta));
  return [...heading(waiting ? 'Chọn prompt để tiếp tục' : 'Tạo phiên bản mới', product.name),
    panel(form(async target => {
      const data = formData(target);
      const chosen = new FormData(target).getAll('images');
      if (chosen.length && !chosen.includes(data.primary)) throw new Error('Ảnh chính phải nằm trong danh sách ảnh đã chọn.');
      if (!chosen.length) throw new Error('Chọn ít nhất một ảnh sản phẩm.');
      data.images = [...new Set([data.primary, ...chosen])];
      if (data.useScript) {
        const value = (entry, fieldName) => entry.querySelector('[name="' + fieldName + '"]').value;
        data.script = {
          scenes: [...sceneList.children].map(entry => ({ visual: value(entry, 'sceneVisual'),
            voice: value(entry, 'sceneVoice'), overlay: value(entry, 'sceneOverlay'), seconds: value(entry, 'sceneSeconds') })),
          caption: data.scriptCaption, hashtags: data.scriptHashtags.split(/\s+/).filter(Boolean), cta: data.scriptCta,
        };
      }
      for (const key of Object.keys(data)) if (key.startsWith('scene') || /^script(Caption|Hashtags|Cta)$/.test(key)) delete data[key];
      data.character = (await files(target.elements.character, 1))[0] || '';
      if (data.keepCharacter && inputs?.character) data.characterFile = inputs.character;
      data.baseId = base?.id;
      if (waiting) data.resumeId = base.id;
      await commit('products/' + product.id + '/version', data, 'Đã đưa phiên bản vào hàng đợi.', 'product/' + product.id);
    }, field('Mẫu prompt', 'templateId', inputs?.templateId || '', {
      choices: [['', 'Tự phân nhóm / dùng mẫu chung'], ...state.templates.map(template => [template.id, template.name])], required: Boolean(waiting),
    }), editor,
    node('h2', {}, 'Ảnh tham chiếu'),
    gallery(product.images),
    row(product.images.map((file, index) => checkbox('Dùng ảnh ' + (index + 1), 'images', selected.has(file), file))),
    field('Ảnh chính', 'primary', inputs?.images[0] || product.images[0], { choices: product.images.map((file, index) => [file, 'Ảnh ' + (index + 1)]) }),
    imageField('Ảnh nhân vật mới', 'character'),
    inputs?.character && checkbox('Giữ ảnh nhân vật của phiên bản trước', 'keepCharacter', true),
    checkbox('Bỏ ảnh nhân vật ở phiên bản này', 'noCharacter'),
    detail('Thiết lập chuyên sâu',
      field('Prompt viết kịch bản riêng', 'scriptPrompt', inputs?.scriptPrompt || '', { type: 'textarea', hint: 'Để trống để dùng prompt của mẫu.' }),
      field('Quy tắc tạo video riêng', 'rules', inputs?.rules || '', { type: 'textarea' }),
      grid(field('Model video riêng', 'videoModel', inputs?.videoModel || ''), field('Độ phân giải', 'resolution', inputs?.resolution || ''),
        field('Tỷ lệ khung hình', 'aspect', inputs?.aspect || '', { choices: aspectChoices }),
        field('Thời lượng (giây)', 'duration', inputs?.duration || '', { type: 'number', min: 1, max: 120 }))),
    row(submit(waiting ? 'Lưu và tiếp tục' : 'Đưa vào hàng đợi'), link('Về hồ sơ', '#product/' + product.id, false, true))))];
}

function templatesScreen(id) {
  const selected = state.templates.find(item => item.id === id);
  const item = selected || {};
  return [
    ...heading('Kho prompt', 'Tạo mẫu theo nhóm sản phẩm và chọn mẫu chung cho các sản phẩm chưa phân nhóm.'),
    panel(node('div', { class: 'stack' }, state.templates.map(template => row(
      link(template.name, '#templates/' + template.id, false, true),
      template.id === state.defaultTemplate && node('span', { class: 'status' }, 'Mẫu chung'),
      template.group && node('span', { class: 'muted small' }, template.group),
    ))), state.templates.length > 0 && node('br'), link('Tạo mẫu mới', '#templates', false, true)),
    panel(node('h2', {}, selected ? 'Chỉnh mẫu · bản ' + selected.revision : 'Mẫu mới'),
      form(async target => {
        const data = formData(target);
        data.character = (await files(target.elements.character, 1))[0] || '';
        await commit('templates' + (selected ? '/' + selected.id : ''), data, 'Đã lưu mẫu.');
      }, field('Tên mẫu', 'name', item.name, { required: true }),
      grid(field('Tên nhóm sản phẩm', 'group', item.group, { hint: 'Để trống nếu chỉ dùng làm mẫu chung.' }),
        field('Tiêu chí phân nhóm', 'criteria', item.criteria, { type: 'textarea', hint: 'Ví dụ: dụng cụ nấu ăn, thiết bị nhà bếp.' })),
      field('Prompt viết kịch bản', 'script', item.script, { type: 'textarea', tall: true, required: true }),
      field('Quy tắc tạo video', 'rules', item.rules, { type: 'textarea', required: true }),
      item.character && gallery([item.character]), imageField('Ảnh nhân vật mặc định', 'character'),
      item.character && checkbox('Gỡ ảnh nhân vật hiện có', 'removeCharacter'),
      checkbox('Dùng làm mẫu chung', 'makeDefault', Boolean(selected && selected.id === state.defaultTemplate)),
      submit('Lưu mẫu'))),
  ];
}

function settingsScreen() {
  const config = state.settings;
  const capabilities = node('div', {});
  return [
    ...heading('Cài đặt', 'Thiết lập API, mẫu video, hàng đợi và nơi lưu kết quả.'),
    panel(node('h2', {}, 'mac2API và video'),
      form(target => commit('settings', formData(target), 'Đã lưu cài đặt.'),
        field('Địa chỉ API cục bộ', 'macBase', config.macBase, { required: true }),
        field('Khóa người dùng mac2API', 'macKey', '', { type: 'password', autocomplete: 'off', hint: config.hasMacKey ? 'Đã lưu khóa. Để trống để giữ khóa hiện có.' : 'Nhập khóa bắt đầu bằng m2c_.' }),
        grid(field('Model phân nhóm và viết kịch bản', 'textModel', config.textModel, { required: true }),
          field('Model tạo video', 'videoModel', config.videoModel, { required: true }),
          field('Tỷ lệ mặc định', 'aspect', config.aspect, { choices: aspectChoices.slice(1) }),
          field('Độ phân giải', 'resolution', config.resolution, { hint: 'Để trống để dùng thiết lập của model.' }),
          field('Thời lượng mục tiêu (giây)', 'duration', config.duration, { type: 'number', min: 1, max: 120, required: true }),
          field('Số ảnh tối đa gửi cho video', 'maxImages', config.maxImages, { type: 'number', min: 1, max: 10, required: true }),
          field('Số tác vụ video đồng thời', 'parallelVideos', config.parallelVideos, { type: 'number', min: 1, max: 8, required: true }),
          field('Kiểm tra tiến độ mỗi (giây)', 'pollSeconds', config.pollSeconds, { type: 'number', min: 5, max: 120, required: true })),
        row(submit('Lưu cài đặt API'), button('Kiểm tra kết nối đã lưu', async () => {
          const data = await api('mac/check', {});
          capabilities.replaceChildren(message('Đã kết nối mac2API' + (data.serverVersion ? ' · ' + data.serverVersion : '') + '.'),
            ...data.models.map(model => muted([model.id, model.ready ? 'Sẵn sàng' : 'Chưa sẵn sàng',
              model.type === 'video' && Number.isFinite(model.maxReferences) ? 'Công bố ' + model.maxReferences + ' ảnh tham chiếu' : ''].filter(Boolean).join(' · '))));
        }))), capabilities),
    panel(node('h2', {}, 'Chrome extension'),
      muted('Cài thư mục extension qua chrome://extensions, mở tiện ích và dán mã kết nối. Chrome cần mở khi lấy dữ liệu sản phẩm.'),
      row(button('Sao chép mã kết nối', () => copy(config.extensionKey)), config.extensionSeen && muted('Lần kết nối gần nhất ' + date(config.extensionSeen)))),
    panel(node('h2', {}, 'Google Drive'),
      node('p', {}, config.googleConnected ? 'Đã kết nối Google Drive.' : 'Chưa kết nối Google Drive.'),
      form(target => commit('settings', formData(target), 'Đã lưu cấu hình Google Drive.'),
        field('OAuth Client ID', 'googleClient', config.googleClient, { autocomplete: 'off' }),
        field('OAuth Client Secret', 'googleSecret', '', { type: 'password', autocomplete: 'off', hint: config.hasGoogleSecret ? 'Đã lưu. Để trống để giữ giá trị hiện có.' : '' }),
        field('Tên thư mục gốc', 'googleRootName', config.googleRootName, { required: true }),
        muted('URI chuyển hướng OAuth: ' + state.oauthRedirect),
        row(submit('Lưu cấu hình Drive'), button('Sao chép URI chuyển hướng', () => copy(state.oauthRedirect)))),
      row(button(config.googleConnected ? 'Kết nối lại Google Drive' : 'Kết nối Google Drive', async () => {
        const { url } = await api('google/start', {});
        location.assign(url);
      }, true), config.googleConnected && button('Ngắt kết nối', () => commit('google/disconnect', {}, 'Đã ngắt kết nối trong app.')))),
  ];
}

function errorsScreen() {
  return [
    ...heading('Báo lỗi', 'Xem bước gặp lỗi, cách xử lý và xuất báo cáo để gửi hỗ trợ.'),
    panel(row(button('Tải báo cáo lỗi', async () => {
      const data = await api('diagnostics');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const file = node('a', { href: url, download: 'bao-cao-loi-affiliate.json' });
      file.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      announce('Đã xuất báo cáo lỗi.');
    }, true), button('Làm mới', () => refresh(true))),
    !state.errors.length && muted('Chưa có lỗi được ghi nhận.')),
    ...state.errors.map(item => panel(row(node('strong', {}, item.code), muted(date(item.time))), message(item.message, true),
      item.suggestion && muted(item.suggestion), item.step && muted('Bước: ' + (stages[item.step] || item.step)),
      row(item.productId && link('Mở hồ sơ', '#product/' + item.productId, false, true), item.lineId && link('Xem tiến độ nhập', '#queue/' +
        (state.batches.find(batch => batch.lines.some(line => line.id === item.lineId))?.id || ''), false, true)))),
  ];
}

const screens = {
  create: createScreen, queue: queueScreen, manual: manualScreen, products: productsScreen, product: productScreen,
  version: versionScreen, templates: templatesScreen, settings: settingsScreen, errors: errorsScreen,
};
function render(force = false) {
  if (!state) return;
  const [page, id, job] = (location.hash.slice(1) || 'create').split('/');
  const pageKey = [page, id, job].join('/');
  const nav = { product: 'products', version: 'products', manual: 'queue' }[page] || page;
  const view = JSON.stringify({ pageKey, state: { ...state, settings: { ...state.settings, extensionSeen: undefined } } });
  if (!force && (dirty || view === lastView || page === 'settings' || (document.activeElement !== main && main.contains(document.activeElement)))) return;
  const switching = activePage !== pageKey;
  lastView = view;
  activePage = pageKey;
  document.querySelectorAll('nav a').forEach(item => {
    if (item.getAttribute('href') === '#' + nav) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  const opened = [...main.querySelectorAll('details')].map(item => item.open);
  main.replaceChildren(...(screens[page] || createScreen)(id, job));
  if (!switching) main.querySelectorAll('details').forEach((item, index) => { item.open = opened[index] || false; });
  if (switching) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
}
async function refresh(force = false) {
  if (loading && !force) return;
  loading = true;
  const connection = document.querySelector('#connection');
  try {
    state = await api('state');
    connection.textContent = 'Đã kết nối cục bộ';
    render(force);
  } catch {
    connection.textContent = 'Mất kết nối ứng dụng';
    if (!state) main.replaceChildren(message('Chưa kết nối được với app. Hãy kiểm tra cửa sổ chạy server.', true));
  } finally { loading = false; }
}
main.addEventListener('input', event => { if (event.target.closest('form')) dirty = true; });
window.addEventListener('hashchange', () => {
  if (location.hash === '#main') { main.focus(); return; }
  dirty = false;
  render(true);
});
void refresh(true);
setInterval(refresh, 2000);
