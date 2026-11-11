const $ = id => document.getElementById(id);
let state = { history: [], settings: {} }, round = null, verdict = null, busy = false, timer;
const count = value => Array.from(value).length;
async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data; try { data = await response.json(); } catch { throw new Error('Игра потеряла связь с локальным сервером. Запусти её заново.'); }
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.');
  return data;
}
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function updateInput() {
  const n = count($('caption').value);
  $('counter').textContent = `${n} / 50`;
  $('counter').classList.toggle('over-limit', n > 50);
  $('judge-button').disabled = busy || !round || Boolean(verdict) || !state.settings.model || !state.settings.model.trim() || !n || n > 50 || !$('caption').value.trim();
}
function setBusy(value) {
  busy = value; $('caption').disabled = value || Boolean(verdict);
  ['skip-photo', 'upload-button', 'next-round', 'settings-open', 'rejudge', 'save-feedback', 'feedback-comment'].forEach(id => $(id).disabled = value);
  document.querySelectorAll('[data-feedback]').forEach(button => button.disabled = value);
  updateInput();
}
function updateStats() {
  $('history-count').textContent = state.history.length;
  $('best-score').textContent = state.history.length ? Math.max(...state.history.map(x => x.score)) : '—';
}
function resetVerdict() {
  verdict = null; $('verdict').hidden = true; $('judge-loading').hidden = true; $('judge-idle').hidden = false;
  $('feedback-comment').value = ''; delete $('feedback-comment').dataset.resultId;
  $('caption').value = ''; $('caption').disabled = false;
}
async function displayRound(data) {
  const response = await fetch(data.image);
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || 'Не удалось получить фотографию с ПК (' + response.status + ').');
  }
  if (!response.headers.get('content-type')?.startsWith('image/')) throw new Error('Туннель вернул страницу вместо фотографии. Перезайди по полной ссылке.');
  const photoURL = URL.createObjectURL(await response.blob());
  const image = $('photo');
  try { await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Не удалось показать фотографию. Попробуй другую.')); image.src = photoURL; }); } finally { URL.revokeObjectURL(photoURL); }
  $('photo-selection-note').textContent = data.source.selectionNote || '';
  round = data; image.hidden = false; $('photo-placeholder').hidden = true;
  $('photo-source').textContent = data.source.label + (data.source.url ? ' ↗' : '');
  if (data.source.url) $('photo-source').href = data.source.url; else $('photo-source').removeAttribute('href');
}
async function newRound(image) {
  if (busy) return;
  error(); setBusy(true);
  $('photo-selection-note').textContent = image ? 'Загружаем твою фотографию…' : 'Подбираем фотографию…';
  try {
    if (verdict && $('feedback-comment').value.trim() !== (verdict.feedbackComment || '')) await saveFeedback();
    const data = image ? await api('/api/upload', { image }) : await api('/api/round', {});
    await displayRound(data); resetVerdict();
  } catch (e) {
    error(e.message);
    if (!round) { $('photo-placeholder').querySelector('strong').textContent = 'Фото не загрузилось'; $('photo-placeholder').querySelector('span:last-child').textContent = 'Повтори загрузку или выбери свою фотографию.'; }
  } finally { setBusy(false); }
}
function renderVerdict(result) {
  $('rejudge-note').textContent = result.previousScore === undefined ? '' : `Переоценка: ${result.previousScore} → ${result.score}. Пояснение сохранено.`;
  verdict = result; $('judge-idle').hidden = true; $('judge-loading').hidden = true; $('verdict').hidden = false;
  $('score').textContent = result.score; $('passed').textContent = result.passed ? 'ЗАЧЁТ' : 'НЕ ЗАШЛО'; $('passed').classList.toggle('fail', !result.passed);
  $('judge-comment').textContent = '«' + result.comment + '»'; $('explanation').textContent = result.explanation;
  $('breakdown').replaceChildren(...[['Связь с фото', 'relevance', 25], ['Поворот', 'surprise', 30], ['Юмор', 'humor', 30], ['Подача', 'delivery', 15]].map(([label, key, max]) => {
    const el = document.createElement('div'), name = document.createElement('span'), value = document.createElement('b'); name.textContent = label; value.textContent = `${result[key]}/${max}`; el.append(name, value); return el;
  }));
  document.querySelectorAll('[data-feedback]').forEach(button => button.classList.toggle('selected', button.dataset.feedback === result.feedback));
  if ($('feedback-comment').dataset.resultId !== result.id) {
    $('feedback-comment').dataset.resultId = result.id; $('feedback-comment').value = result.feedbackComment || '';
  }
  $('feedback-note').textContent = result.feedback || result.feedbackComment ? 'Сохранено.' : '';
}
$('caption').addEventListener('input', updateInput);
$('caption-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('judge-button').disabled) return;
  setBusy(true); error(); $('judge-idle').hidden = true; $('judge-loading').hidden = false;
  const start = Date.now(); $('elapsed').textContent = '0 СЕК'; timer = setInterval(() => $('elapsed').textContent = Math.round((Date.now() - start) / 1000) + ' СЕК', 1000);
  try {
    const result = await api('/api/judge', { roundId: round.id, caption: $('caption').value });
    if (!state.history.some(x => x.id === result.id)) state.history.push(result);
    renderVerdict(result); updateStats();
  } catch (e) { error(e.message); $('judge-idle').hidden = false; }
  finally { clearInterval(timer); $('judge-loading').hidden = true; setBusy(false); }
});
['skip-photo', 'next-round'].forEach(id => $(id).addEventListener('click', () => newRound()));
$('upload-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file || busy) return;
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Выбери фотографию до 25 МБ.');
    const bitmap = await createImageBitmap(file);
    const ratio = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * ratio); canvas.height = Math.round(bitmap.height * ratio);
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    await newRound(canvas.toDataURL('image/jpeg', 0.88));
  } catch (e) { error(e.message || 'Не удалось открыть фотографию.'); }
  event.target.value = '';
});
let feedbackSaving = null;
async function saveFeedback(feedback) {
  if (feedbackSaving) await feedbackSaving;
  if (!verdict) return;
  const current = verdict, comment = $('feedback-comment').value;
  if (count(comment) > 1000) throw new Error('Пояснение: максимум 1000 символов.');
  const buttons = [...document.querySelectorAll('[data-feedback]'), $('save-feedback')];
  buttons.forEach(button => button.disabled = true);
  feedbackSaving = (async () => {
    const result = await api('/api/feedback', { id: current.id, comment, ...(feedback ? { feedback } : {}) });
    current.feedback = result.feedback; current.feedbackComment = result.comment;
    const item = state.history.find(x => x.id === current.id); if (item) Object.assign(item, { feedback: result.feedback, feedbackComment: result.comment });
    if (verdict === current) renderVerdict(current);
  })();
  try { await feedbackSaving; }
  finally { feedbackSaving = null; buttons.forEach(button => button.disabled = false); }
}
document.querySelectorAll('[data-feedback]').forEach(button => button.addEventListener('click', async () => {
  try { await saveFeedback(button.dataset.feedback); } catch (e) { error(e.message); }
}));
$('save-feedback').addEventListener('click', async () => { try { await saveFeedback(); } catch (e) { error(e.message); } });
$('rejudge').addEventListener('click', async () => {
  if (busy || !verdict || !round) return;
  const comment = $('feedback-comment').value.trim();
  if (!comment || count(comment) > 1000) return error('Напиши пояснение от 1 до 1000 символов.');
  if (feedbackSaving) await feedbackSaving.catch(() => {});
  setBusy(true); error(); $('rejudge-note').textContent = 'Пересчитываем оценку…';
  try {
    const result = await api('/api/rejudge', { roundId: round.id, comment });
    const index = state.history.findIndex(x => x.id === result.id);
    if (index >= 0) state.history[index] = result;
    renderVerdict(result); updateStats();
  } catch(e) { error(e.message); $('rejudge-note').textContent = 'Осталась прежняя оценка. Можно повторить.'; }
  finally { setBusy(false); }
});
$('feedback-comment').addEventListener('input', () => { $('feedback-note').textContent = 'Пояснение не сохранено'; });
window.addEventListener('beforeunload', event => {
  if (verdict && $('feedback-comment').value.trim() !== (verdict.feedbackComment || '')) { event.preventDefault(); event.returnValue = ''; }
});
function populateSettings() {
  $('smartPhotos').checked = state.settings.smartPhotos !== false;
  for (const key of ['endpoint', 'model', 'strictness', 'memes', 'photoProvider', 'yandexFolder']) $(key).value = state.settings[key] || (key === 'photoProvider' ? 'auto' : '');
}
$('settings-open').addEventListener('click', () => { populateSettings(); $('settings-dialog').showModal(); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
async function saveSettings() {
  const settings = Object.fromEntries(['endpoint', 'model', 'strictness', 'memes', 'photoProvider', 'yandexFolder'].map(key => [key, $(key).value]));
  settings.smartPhotos = $('smartPhotos').checked;
  await api('/api/settings', { ...settings, token: $('token').value }); state.settings = settings; updateInput();
}
async function checkConnection(showModels = false) {
  if (state.remote) {
    $('settings-open').hidden = true;
    return true;
  }
  try {
    const data = await api('/api/models');
    $('connection-dot').classList.add('online'); $('connection-text').textContent = 'LM Studio на связи';
    if (showModels) {
      $('models').replaceChildren(...data.models.map(id => { const option = document.createElement('option'); option.value = id; return option; }));
      if (!$('model').value) $('model').value = data.models.find(x => /qwen.*vl/i.test(x)) || data.models[0] || '';
      $('model-status').textContent = data.models.length ? `Связь есть. Найдено моделей: ${data.models.length}. Выбери модель с поддержкой фото и нажми «Сохранить».` : 'Сервер работает, но моделей нет. Загрузи Qwen3-VL в LM Studio.';
    }
    return true;
  } catch (e) {
    $('connection-dot').classList.remove('online'); $('connection-text').textContent = 'Подключить LM Studio';
    if (showModels) $('model-status').textContent = e.message;
    return false;
  }
}
$('check-models').addEventListener('click', async () => {
  $('check-models').disabled = true; $('settings-error').hidden = true; $('model-status').textContent = 'Проверяем локальный сервер…';
  try { await saveSettings(); await checkConnection(true); } catch (e) { $('settings-error').textContent = e.message; $('settings-error').hidden = false; }
  finally { $('check-models').disabled = false; }
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault(); $('settings-error').hidden = true;
  try { await saveSettings(); $('settings-dialog').close(); await checkConnection(); } catch (e) { $('settings-error').textContent = e.message; $('settings-error').hidden = false; }
});
$('history-open').addEventListener('click', () => {
  if (state.remote) return;
  const list = $('history-list'); list.replaceChildren();
  if (!state.history.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Коллекция пуста.'; list.append(p); }
  for (const item of [...state.history].reverse()) {
    const article = document.createElement('article'); article.className = 'history-item';
    const score = document.createElement('div'); score.className = 'history-score'; score.textContent = item.score;
    const body = document.createElement('div'), title = document.createElement('h3'), comment = document.createElement('p'), scene = document.createElement('p'), meta = document.createElement('small');
    title.textContent = item.caption; comment.textContent = item.comment; scene.textContent = 'На фото: ' + item.scene;
    meta.textContent = new Date(item.date).toLocaleString('ru-RU') + ' · ' + (item.passed ? 'Зачёт' : 'Не зашло');
    const label = document.createElement('label'), note = document.createElement('textarea'), save = document.createElement('button'), status = document.createElement('small');
    note.id = 'note-' + item.id; note.value = item.feedbackComment || ''; note.maxLength = 1000; note.rows = 2; note.placeholder = 'Почему это смешно?';
    label.htmlFor = note.id; label.textContent = 'Твоё пояснение'; label.className = 'history-note-label';
    save.textContent = 'Сохранить пояснение'; save.className = 'secondary history-save'; status.setAttribute('role', 'status');
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const result = await api('/api/feedback', { id: item.id, comment: note.value });
        item.feedbackComment = result.comment; status.textContent = 'Сохранено.';
        if (verdict?.id === item.id) { verdict.feedbackComment = result.comment; $('feedback-comment').value = result.comment; renderVerdict(verdict); }
      } catch (e) { status.textContent = e.message; }
      finally { save.disabled = false; }
    });
    body.append(title, comment, scene, meta, label, note, save, status); article.append(score, body); list.append(article);
  }
  $('history-dialog').showModal();
});
$('export-history').addEventListener('click', () => {
  if (state.remote) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.history, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'podpis-history.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function init() {
  try {
    state = await api('/api/state'); updateStats(); populateSettings(); updateInput();
    if (state.remote) document.querySelector('.brand').href = '/' + location.hash;
    $('history-open').hidden = Boolean(state.remote);
    $('share-open').hidden = Boolean(state.remote); $('settings-open').hidden = Boolean(state.remote);
    if (!state.remote && location.hash === '#share') { history.replaceState(null, '', '/'); openShare(); }
    await Promise.allSettled([newRound(), checkConnection()]);
  }
  catch (e) { error(e.message); }
}
let shareTimer, shareLink = '';
function renderShare(status) {
  if (shareLink !== status.link) $('share-copy-note').textContent = '';
  shareLink = status.phase === 'ready' ? status.link : '';
  $('share-link').value = shareLink;
  $('share-copy').disabled = !shareLink;
  $('share-create').disabled = status.phase === 'starting';
  $('share-stop').disabled = !['starting', 'ready'].includes(status.phase);
  $('share-create').textContent = status.phase === 'ready' ? 'Создать новую ссылку' : 'Создать ссылку';
  $('share-status').textContent = status.phase === 'starting' ? 'Создаём ссылку…' : status.phase === 'ready' ? 'Ссылка действует до 12 часов.' : status.phase === 'error' ? status.error : 'Внешний доступ выключен.';
}
async function pollShare() {
  clearTimeout(shareTimer);
  if (!$('share-dialog').open) return;
  try { renderShare(await api('/api/share/status')); }
  catch { $('share-status').textContent = 'Нет связи с игрой на ПК.'; shareLink = ''; $('share-link').value = ''; $('share-copy').disabled = true; }
  if ($('share-dialog').open) shareTimer = setTimeout(pollShare, 2000);
}
function openShare() { $('share-dialog').showModal(); void pollShare(); }
$('share-open').addEventListener('click', openShare);
$('share-dialog').addEventListener('close', () => clearTimeout(shareTimer));
$('share-create').addEventListener('click', async () => {
  $('share-create').disabled = true; $('share-status').textContent = 'Создаём ссылку…';
  try { renderShare(await api('/api/share/start', { provider: $('share-provider').value })); void pollShare(); }
  catch (e) { $('share-status').textContent = e.message; $('share-create').disabled = false; }
});
$('share-stop').addEventListener('click', async () => {
  try { renderShare(await api('/api/share/stop', {})); }
  catch (e) { $('share-status').textContent = e.message; }
});
$('share-copy').addEventListener('click', async () => {
  if (!shareLink) return;
  try { await navigator.clipboard.writeText(shareLink); $('share-copy-note').textContent = 'Ссылка скопирована.'; }
  catch { $('share-link').focus(); $('share-link').select(); $('share-copy-note').textContent = 'Ссылка выделена: нажми Ctrl+C или выбери «Копировать».'; }
});
init();

$('group-create').addEventListener('click', async () => { try { const r = await api('/api/rooms/create', {}); location.href = '/group#room=' + r.room; } catch(e) { error(e.message); } });
