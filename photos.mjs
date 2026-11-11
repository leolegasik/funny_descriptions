import { randomUUID, randomInt } from 'node:crypto';
import { createStockLoader } from './stock-photos.mjs';

export const PHOTO_PROVIDERS = ['auto', 'rupixel', 'perfectstock', 'picsum', 'yandex'];
const MAX_IMAGE = 5 * 1024 * 1024;
const ALLOWED_HOSTS = ['www.rupixel.ru', 'rupixel.ru', 'www.perfectstock.ru', 'perfectstock.ru', 'picsum.photos', 'fastly.picsum.photos', 'cloud-api.yandex.net'];
function safeURL(value) {
  const url = new URL(value);
  const yandex = ['yandex.net', 'yandex.ru', 'yandex.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || (!ALLOWED_HOSTS.includes(url.hostname) && !yandex)) throw new Error('Источник вернул неподдерживаемую ссылку.');
  return url;
}
export function validateYandexFolder(value) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 1000) throw new Error('Проверь ссылку на папку Яндекс.Диска.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Нужна публичная ссылка на папку Яндекс.Диска.'); }
  if (url.protocol !== 'https:' || !['disk.yandex.ru', 'disk.yandex.com', 'disk.360.yandex.ru', 'yadi.sk'].includes(url.hostname) || url.username || url.password || url.port || !/^\/(d|i)\/[^/]+\/?$/.test(url.pathname)) throw new Error('Нужна ссылка вида https://disk.yandex.ru/d/… на открытую папку с фото.');
  url.search = ''; url.hash = ''; return url.href;
}
export function createPhotoLoader(photoFetch = fetch, { history = {} } = {}) {
  async function request(value, signal) {
    let url = safeURL(value);
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await photoFetch(url.href, { redirect: 'manual', signal, headers: { 'User-Agent': 'PodpisLocal/1.1' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new Error('Источник не вернул фото.');
        url = safeURL(new URL(location, url).href); continue;
      }
      if (!response.ok) throw new Error(`Источник фото ответил ${response.status}.`);
      return response;
    }
    throw new Error('Слишком много перенаправлений источника фото.');
  }
  async function readLimited(response, limit) {
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Ответ источника слишком большой.'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('Ответ источника слишком большой.'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function json(url, signal) {
    return JSON.parse((await readLimited(await request(url, signal), 2 * 1024 * 1024)).toString('utf8'));
  }
  async function readImage(url, signal) {
    const response = await request(url, signal);
    const mime = response.headers.get('content-type')?.split(';')[0];
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) { await response.body?.cancel(); throw new Error('Источник вернул не фотографию JPEG, PNG или WebP.'); }
    return { bytes: await readLimited(response, MAX_IMAGE), mime };
  }
  const loadStock = createStockLoader({ history, readImage, readText: async (url, signal) => (await readLimited(await request(url, signal), 3 * 1024 * 1024)).toString('utf8') });
  async function fromProvider(provider, settings) {
    const signal = AbortSignal.timeout(12000);
    let imageURL, source;
    if (provider === 'picsum') {
      imageURL = `https://picsum.photos/seed/${randomUUID()}/1000/700`;
      source = { label: 'Lorem Picsum', url: imageURL, provider };
    } else if (provider === 'yandex') {
      const folder = validateYandexFolder(settings.yandexFolder);
      if (!folder) throw new Error('В настройках добавь публичную ссылку на папку Яндекс.Диска с фотографиями.');
      const query = new URLSearchParams({ public_key: folder, limit: '1000', preview_size: 'XL', preview_crop: 'false' });
      const album = await json('https://cloud-api.yandex.net/v1/disk/public/resources?' + query, signal);
      const items = album.type === 'file' ? [album] : album._embedded?.items || [];
      const photos = items.filter(x => x.type === 'file' && /^image\/(jpeg|png|webp)$/.test(x.mime_type) && x.preview);
      if (!photos.length) throw new Error('В папке Яндекс.Диска нет доступных JPEG, PNG или WebP. Помести фотографии прямо в папку, без вложенных папок.');
      imageURL = photos[randomInt(photos.length)].preview;
      source = { label: 'Яндекс.Диск', url: folder, provider };
    } else { throw new Error('Выбери источник фото в настройках.'); }
    return { ...await readImage(imageURL, signal), source };
  }
  return async settings => {
    const selected = settings.photoProvider || 'auto';
    if (['auto', 'rupixel', 'perfectstock', 'cats', 'dogs'].includes(selected)) return loadStock(['cats', 'dogs'].includes(selected) ? 'auto' : selected);
    if (selected !== 'auto') {
      try { return await fromProvider(selected, settings); }
      catch (error) { throw new Error(`Не удалось загрузить фото. ${error.name === 'TimeoutError' ? 'Источник не ответил за 12 секунд.' : error.message} Выбери другой источник в настройках или своё фото.`); }
    }
  };
}
