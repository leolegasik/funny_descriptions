import { randomInt, createHash } from 'node:crypto';

export const STOCK_SOURCES = {
  rupixel: { host: 'www.rupixel.ru', name: 'RuPixel' },
  perfectstock: { host: 'www.perfectstock.ru', name: 'PerfectStock' }
};
// Related sections share a topic, so changing a section cannot bypass the cooldown.
export const STOCK_TOPICS = [
  { id: 'people', label: 'Люди', categories: ['people', 'emotions', 'fashion'] },
  { id: 'food', label: 'Еда и напитки', categories: ['foods-drinks'] },
  { id: 'city', label: 'Город и архитектура', categories: ['city', 'architecture', 'places'] },
  { id: 'work', label: 'Работа и ремесло', categories: ['business', 'industry', 'construction'] },
  { id: 'technology', label: 'Техника и наука', categories: ['computer', 'science-technology'] },
  { id: 'sports', label: 'Спорт', categories: ['sports'] },
  { id: 'nature', label: 'Природа', categories: ['nature-landscapes'] },
  { id: 'music', label: 'Музыка', categories: ['music'] },
  { id: 'education', label: 'Учёба', categories: ['education'] },
  { id: 'celebration', label: 'Праздники', categories: ['holidays'] },
  { id: 'health', label: 'Здоровье', categories: ['health'] },
  { id: 'transport', label: 'Транспорт', categories: ['cars'] },
  { id: 'animals', label: 'Животные', categories: ['animals'] }
];
const decode = text => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));
function attr(tag, name) {
  const match = tag.match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(["\'])([\\s\\S]*?)\\1', 'i'));
  return match ? decode(match[2]) : '';
}
export function parseStockPage(html, origin) {
  const photos = [], seen = new Set();
  for (const match of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const card = match[0], open = card.slice(0, card.indexOf('>') + 1);
    let page;
    try { page = new URL(attr(open, 'href'), origin); } catch { continue; }
    if (page.origin !== origin || !/^\/photo\/\d+\//.test(page.pathname) || seen.has(page.href)) continue;
    if (/type=premium|fa-crown|icon-premium|\bAI-generated\b/i.test(card)) continue;
    const tags = [...card.matchAll(/<img\b[^>]*>/gi)].map(x => x[0]);
    const image = tags.find(tag => /(?:^|\s)previewImage(?:\s|$)/.test(attr(tag, 'class')));
    if (!image) continue;
    let imageURL;
    try { imageURL = new URL(attr(image, 'src'), origin); } catch { continue; }
    if (imageURL.origin !== origin || !imageURL.pathname.startsWith('/files/preview/')) continue;
    const titleTag = [...card.matchAll(/<[^>]+>/g)].map(x => x[0]).find(tag => attr(tag, 'class').includes('title-hover-content'));
    const title = titleTag ? attr(titleTag, 'title') : '';
    if (/нейросет|сгенерирован|генераци[яи]|\bИИ\b|AI.generated/i.test(title)) continue;
    photos.push({ id: page.href, url: page.href, imageURL: imageURL.href, title }); seen.add(page.href);
  }
  let pages = 1;
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    try { const url = new URL(attr(match[0], 'href'), origin); const page = Number(url.searchParams.get('page')); if (url.origin === origin && url.pathname.startsWith('/category/') && Number.isInteger(page) && page > pages) pages = Math.min(page, 1000); } catch {}
  }
  return { photos, pages };
}
function shuffled(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
function actualTopic(title, categoryTopic) {
  // Some animal pictures also occur in People/Nature. Treat obvious titles as animals.
  return /кошк|кот[ёе]н|собак|щен|лошад|попуг|обезьян|медвед|птиц|тигр|(^|[^\p{L}])(кот|коты|cat|dog|horse)([^\p{L}]|$)/iu.test(title) ? 'animals' : categoryTopic;
}
export function createStockLoader({ readText, readImage, history = {} }) {
  const valid = new Set(STOCK_TOPICS.map(x => x.id));
  history.remainingTopics = (history.remainingTopics || []).filter(x => valid.has(x));
  history.recentTopics = (history.recentTopics || []).filter(x => valid.has(x)).slice(-5);
  history.recentPhotos = (history.recentPhotos || []).slice(-150);
  history.recentImageURLs = (history.recentImageURLs || []).slice(-150);
  history.recentHashes = (history.recentHashes || []).slice(-150);
  const cache = new Map(), unavailableUntil = new Map();
  async function page(url, signal) {
    const cached = cache.get(url);
    if (cached && Date.now() - cached.date < 15 * 60 * 1000) return cached.data;
    const data = parseStockPage(await readText(url, signal), new URL(url).origin);
    cache.set(url, { data, date: Date.now() });
    while (cache.size > 100) cache.delete(cache.keys().next().value);
    return data;
  }
  return async provider => {
    if (!history.remainingTopics.length) history.remainingTopics = shuffled([...valid]);
    const allowedTopics = history.remainingTopics.filter(x => !history.recentTopics.includes(x));
    if (!allowedTopics.length) throw new Error('Не удалось подобрать новую тему. Попробуй ещё раз.');
    // Automatic mode uses only the Russian stock sites, never animal-only services.
    const providers = provider === 'auto' ? ['rupixel', 'perfectstock'] : [provider];
    const errors = [];
    for (const topicId of allowedTopics.slice(0, 3)) {
    const topic = STOCK_TOPICS.find(x => x.id === topicId);
    for (const id of providers) {
      const source = STOCK_SOURCES[id];
      if (!source) throw new Error('Неизвестный фотосток.');
      if (provider === 'auto' && unavailableUntil.get(id) > Date.now()) { errors.push(source.name + ': временно недоступен'); continue; }
      try {
        const signal = AbortSignal.timeout(15000);
        const category = topic.categories[randomInt(topic.categories.length)];
        const base = `https://${source.host}/category/${category}`;
        const first = await page(base, signal);
        const number = randomInt(1, first.pages + 1);
        const selected = number === 1 ? first : await page(`${base}?page=${number}`, signal);
        const candidates = shuffled([...new Map([...selected.photos, ...first.photos].map(x => [x.id, x])).values()]).filter(photo => {
          const classified = actualTopic(photo.title, topic.id);
          return !history.recentPhotos.includes(photo.id) && !history.recentImageURLs.includes(photo.imageURL) && !history.recentTopics.includes(classified) && history.remainingTopics.includes(classified);
        });
        for (const photo of candidates.slice(0, 3)) {
          try {
            const image = await readImage(photo.imageURL, signal);
            const hash = createHash('sha256').update(image.bytes).digest('hex');
            if (history.recentHashes.includes(hash)) continue;
            const classified = actualTopic(photo.title, topic.id);
            const label = STOCK_TOPICS.find(x => x.id === classified).label;
            history.remainingTopics = history.remainingTopics.filter(x => x !== classified);
            history.recentTopics = [...history.recentTopics, classified].slice(-5);
            history.recentPhotos = [...history.recentPhotos, photo.id].slice(-150);
            history.recentImageURLs = [...history.recentImageURLs, photo.imageURL].slice(-150);
            history.recentHashes = [...history.recentHashes, hash].slice(-150);
            return { ...image, source: { label: source.name + ' · ' + label, url: photo.url, provider: id, topic: classified, topicLabel: label, photoId: photo.id } };
          } catch (error) { if (signal.aborted) throw error; }
        }
        // An exhausted category should not starve the other topics on the next request.
        history.remainingTopics = [...history.remainingTopics.filter(x => x !== topic.id), topic.id];
        throw new Error('Не нашлось нового доступного кадра в категории «' + topic.label + '».');
      } catch (error) {
        errors.push(source.name + ': ' + (error.name === 'TimeoutError' ? 'превышено время ожидания' : error.message));
        if (error.name === 'TimeoutError' || error instanceof TypeError) unavailableUntil.set(id, Date.now() + 60000);
      }
    }
    }
    throw new Error('Не удалось загрузить фото. ' + [...new Set(errors)].join('; ') + '. Попробуй другой фотосток в настройках.');
  };
}
