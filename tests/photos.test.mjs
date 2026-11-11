import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoLoader, validateYandexFolder } from '../photos.mjs';
import { parseStockPage, STOCK_TOPICS } from '../stock-photos.mjs';
const image = (bytes = Buffer.from([255, 216, 255, 217])) => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function catalog(origin, category, page = '1') {
  return Array.from({ length: 24 }, (_, i) => `<a class="item hovercard" href="${origin}/photo/${page}${i}/${category}"><span class="title-hover-content" title="Тестовый кадр ${i}"></span><img class="avatar" src="${origin}/public/avatar/default.jpg"><img class="previewImage d-none" src="${origin}/files/preview/${category}-${page}-${i}.jpg"></a>`).join('') + `<a href="${origin}/category/${category}?page=8">8</a>`;
}
async function stockFetch(value) {
  const url = new URL(value);
  if (url.pathname.startsWith('/category/')) return new Response(catalog(url.origin, url.pathname.split('/').pop(), url.searchParams.get('page') || '1'));
  if (url.pathname.startsWith('/files/preview/')) return image(Buffer.from(url.href));
  throw new Error('Unexpected URL: ' + value);
}
test('каталог: фотографии вместо аватаров, без внешних ссылок и premium', () => {
  const origin = 'https://www.rupixel.ru';
  const parsed = parseStockPage(catalog(origin, 'sports') + `<a href="https://evil.test/photo/123/test"><img class="previewImage" src="https://evil.test/image.jpg"></a><a href="${origin}/photo/999/paid"><i class="fa-crown"></i><img class="previewImage" src="${origin}/files/preview/paid.jpg"></a>`, origin);
  assert.equal(parsed.pages, 8); assert.equal(parsed.photos.length, 24);
  assert.ok(parsed.photos.every(x => x.imageURL.startsWith(origin + '/files/preview/')));
});
test('52 раунда: все темы в цикле, нет повторов пяти последних тем и фото; очередь переживает перезапуск', async () => {
  let history = {}, load = createPhotoLoader(stockFetch, { history });
  const topics = [], photos = [];
  for (let i = 0; i < 52; i++) {
    if (i === 21) { history = JSON.parse(JSON.stringify(history)); load = createPhotoLoader(stockFetch, { history }); }
    const result = await load({ photoProvider: 'auto' });
    assert.equal(result.source.provider, 'rupixel');
    assert.ok(!topics.slice(-5).includes(result.source.topic));
    assert.ok(!photos.includes(result.source.photoId));
    topics.push(result.source.topic); photos.push(result.source.photoId);
  }
  for (let i = 0; i < topics.length; i += STOCK_TOPICS.length) assert.equal(new Set(topics.slice(i, i + STOCK_TOPICS.length)).size, STOCK_TOPICS.length);
  assert.equal(topics.filter(x => x === 'animals').length, 4);
  assert.equal(history.recentHashes.length, 52);
});
test('автоматический режим использует российские фотостоки и переключается при ошибке', async () => {
  const urls = [];
  const load = createPhotoLoader(async value => {
    urls.push(value);
    if (new URL(value).hostname === 'www.rupixel.ru') throw new TypeError('Сеть недоступна');
    return stockFetch(value);
  });
  assert.equal((await load({ photoProvider: 'auto' })).source.provider, 'perfectstock');
  assert.ok(urls.every(x => /https:\/\/www\.(rupixel|perfectstock)\.ru\//.test(x)));
  assert.equal((await load({ photoProvider: 'cats' })).source.provider, 'perfectstock');
});
test('дубли содержимого не выдаются под новой ссылкой', async () => {
  const load = createPhotoLoader(async value => value.includes('/files/preview/') ? image() : stockFetch(value));
  await load({ photoProvider: 'rupixel' });
  await assert.rejects(load({ photoProvider: 'rupixel' }), /Не удалось загрузить фото/);
});
test('ручные источники Picsum и Яндекс, проверка публичной ссылки', async () => {
  const load = createPhotoLoader(async value => {
    if (value.startsWith('https://cloud-api.yandex.net/')) return json({ _embedded: { items: [{ type: 'file', mime_type: 'image/jpeg', preview: 'https://downloader.disk.yandex.ru/preview/test' }] } });
    return image();
  });
  for (const provider of ['picsum', 'yandex']) {
    const result = await load({ photoProvider: provider, yandexFolder: 'https://disk.yandex.ru/d/test-album' });
    assert.equal(result.mime, 'image/jpeg'); assert.equal(result.source.provider, provider);
  }
  assert.equal(validateYandexFolder('https://disk.360.yandex.ru/d/abc?foo=bar'), 'https://disk.360.yandex.ru/d/abc');
  assert.throws(() => validateYandexFolder('http://localhost:8765/'));
  assert.throws(() => validateYandexFolder('https://disk.yandex.ru.evil.test/d/a'));
  await assert.rejects(load({ photoProvider: 'yandex' }), /добавь публичную ссылку/);
});
test('запрещены внешние перенаправления и слишком большие изображения', async () => {
  let requests = 0;
  const malicious = createPhotoLoader(async () => { requests++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:1234/v1/models' } }); });
  await assert.rejects(malicious({ photoProvider: 'picsum' }), /неподдерживаемую ссылку/); assert.equal(requests, 1);
  const huge = createPhotoLoader(async () => new Response('x', { headers: { 'content-type': 'image/jpeg', 'content-length': '6000000' } }));
  await assert.rejects(huge({ photoProvider: 'picsum' }), /слишком большой/);
});
