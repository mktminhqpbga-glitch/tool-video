// Runs in the isolated extension world and reads the current product document.
export function readProductPage() {
  const clean = value => typeof value === 'string' ? value.trim() : '';
  const resolve = value => {
    try {
      const url = new URL(value, location.href);
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  };
  const metadata = name => clean(document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]')?.content);
  const all = [];
  function flatten(value) {
    if (Array.isArray(value)) value.forEach(flatten);
    else if (value && typeof value === 'object') {
      all.push(value);
      if (value['@graph']) flatten(value['@graph']);
      if (value.mainEntity) flatten(value.mainEntity);
    }
  }
  for (const tag of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { flatten(JSON.parse(tag.textContent)); } catch { /* Some shops include incomplete metadata. */ }
  }
  const product = all.find(item => [item['@type']].flat().some(type => /(?:^|\/)Product$/i.test(type || '')));
  const canonical = resolve(document.querySelector('link[rel="canonical"]')?.href || '');
  const productMatch = value => /(?:\/product\/|\/view\/product\/|\/shop\/pdp\/|[-/]i\.\d+\.\d+)/i.test(value);
  const url = productMatch(location.pathname) ? location.href : productMatch(canonical) ? canonical : location.href;
  const heading = [...document.querySelectorAll('h1')].find(item => item.getClientRects().length)?.textContent;
  const documentPrice = /(?:\b\d[\d.,]*\s*(?:vnd|vnđ|đồng|₫)|(?:giá|discount|voucher)\s*:)/iu;
  const images = [];
  function addImage(value, alt = '') {
    const link = typeof value === 'string' && resolve(value);
    if (link && !documentPrice.test(alt) && !images.includes(link)) images.push(link);
  }
  for (const image of [product?.image].flat()) addImage(typeof image === 'string' ? image : image?.url || image?.contentUrl);
  if (metadata('og:image')) addImage(metadata('og:image'));
  // Search gallery-specific containers before trying large images in the product header.
  for (const image of document.querySelectorAll('[data-testid*="gallery"] img,[data-e2e*="product-image"] img,[class*="product-image"] img,[class*="gallery"] img')) {
    addImage(image.currentSrc || image.src, image.alt);
  }
  if (!images.length) {
    for (const image of document.querySelectorAll('main img, #main img')) {
      const box = image.getBoundingClientRect();
      if (box.width < 150 || box.height < 150 || box.y > 850 || box.y < -100 || !image.getClientRects().length) continue;
      addImage(image.currentSrc || image.src, image.alt);
      if (images.length >= 4) break;
    }
  }
  const visibleText = (document.body?.innerText || '').slice(0, 1300);
  const auth = /\/(login|signin|verify|captcha|checkpoint)(\/|\?|$)/i.test(location.href)
    || (!product && /đăng nhập để (?:tiếp tục|xem)|log in to continue|verify (?:that )?you are human|security verification|xác minh bảo mật|kéo thanh trượt/i.test(visibleText));
  const name = clean(product?.name) || clean(heading) || metadata('og:title');
  const description = clean(product?.description) || metadata('og:description') || metadata('description');
  const variant = clean(document.querySelector('[aria-pressed="true"][data-variation], [data-testid*="variant"] [aria-selected="true"]')?.textContent);
  const hasProduct = Boolean(product || productMatch(location.pathname) || (canonical && productMatch(canonical)));
  if (auth && !product) return { state: 'login' };
  if (hasProduct && /(?:sản phẩm (?:không tồn tại|đã bị xóa)|product (?:not found|unavailable))/i.test(visibleText) && !product) {
    return { state: 'error', message: 'Trang báo sản phẩm không còn khả dụng. Kiểm tra lại link.' };
  }
  if (!hasProduct) return { state: 'error', message: 'Trang chưa hiển thị thông tin sản phẩm. Kiểm tra link hoặc dùng Nhập thủ công.' };
  const sku = String(product?.productID || '');
  const shopeeId = location.hostname.endsWith('shopee.vn') && (location.pathname.match(/(?:\/product\/|(?:^|[/-])i\.)(\d+)[/.](\d+)(?:$|\/)/i)?.slice(1).join(':') || '');
  return { state: 'ok', url, name, description, variant, productId: shopeeId || sku, urls: images.slice(0, 10) };
}
