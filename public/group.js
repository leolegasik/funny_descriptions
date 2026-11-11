const $ = (id) => document.getElementById(id);
const room = new URLSearchParams(location.hash.slice(1)).get("room");
let player = sessionStorage.getItem("room-player-" + room),
  state = null,
  pending = false,
  lastImage = 0,
  offset = 0,
  copyLink = location.href,
  pollTimer,
  viewKey = "",
  galleryRound = 0,
  galleryRequest = 0;
const colors = ["#b44b45", "#3267ad", "#39815b", "#9564b5", "#a57520"];
async function api(action, body = {}) {
  const r = await fetch("/api/rooms/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room, player, imageRound: lastImage, ...body }),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Нет связи с игрой");
  return data;
}
function error(e) {
  $("error").textContent = e?.message || "";
}
function render(s) {
  const previous = state;
  state = s;
  offset = s.serverTime - Date.now();
  $("join").hidden = true;
  $("gate").hidden = true;
  $("game").hidden = false;
  $("leave").hidden = false;
  $("status").textContent = {
    lobby: "Лобби",
    loading: "Подбираем общий кадр…",
    answering: `Раунд ${s.round} из ${s.count}`,
    judging: "Оцениваем ответы…",
    results: `Результаты раунда ${s.round}`,
    finished: "Игра завершена",
    error: "Не удалось продолжить",
  }[s.phase];
  $("players").replaceChildren(
    ...s.players.map((p) => {
      const el = document.createElement("div");
      el.className = "player";
      const icon = document.createElement("span");
      icon.className = "avatar c" + colors.indexOf(p.color);
      icon.textContent = "♟";
      el.append(
        icon,
        document.createTextNode(
          p.name +
            (p.id === s.host ? " · хост" : "") +
            (p.ready ? " ✓" : "") +
            (!p.online ? " · нет связи" : ""),
        ),
      );
      return el;
    }),
  );
  const host = s.you === s.host;
  $("setup").hidden = !(host && s.phase === "lobby");
  $("waiting").textContent =
    s.phase === "lobby"
      ? "От 2 до 5 игроков. " +
        (host ? "Выбери настройки и начинай." : "Настройки выбирает хост.")
      : s.submitted && s.phase === "answering"
        ? "Ответ принят. Ждём остальных."
        : "";
  $("start").disabled = s.players.filter((p) => p.online).length < 2;
  $("again").hidden = !(host && s.phase === "finished");
  $("retry").hidden = !(host && s.phase === "error");
  $("answer").hidden = s.phase !== "answering";
  $("caption").disabled = s.submitted;
  $("submit").disabled = s.submitted || pending;
  if (previous?.round !== s.round || previous?.phase === "lobby") {
    $("caption").value = "";
  }
  if (s.image) {
    $("photo").src = s.image;
    lastImage = s.round;
  }
  $("photo").hidden =
    !lastImage ||
    s.phase === "lobby" ||
    s.phase === "loading" ||
    s.phase === "finished";
  if (s.error) $("error").textContent = s.error;
  renderRanking(s, previous);
  renderGallery(s);
  renderResults(s);
}
function renderRanking(s, previous) {
  if (
    s.phase === "finished" &&
    previous?.phase === "finished" &&
    JSON.stringify(s.standings) === JSON.stringify(previous.standings)
  )
    return;
  if (s.phase === "finished") {
    const title = document.createElement("h2");
    title.textContent = "Итоговая таблица";
    const table = document.createElement("table");
    const head = table.insertRow();
    for (const text of ["Место", "Игрок", "Баллы"]) {
      const cell = document.createElement("th");
      cell.textContent = text;
      head.append(cell);
    }
    const sorted = [...(s.standings || s.players)].sort(
      (a, b) => b.total - a.total,
    );
    let rank = 1;
    sorted.forEach((p, i) => {
      if (i && p.total !== sorted[i - 1].total) rank = i + 1;
      const row = table.insertRow();
      for (const text of [rank, p.name + (p.left ? " · вышел" : ""), p.total])
        row.insertCell().textContent = text;
    });
    $("ranking").replaceChildren(title, table);
  } else $("ranking").replaceChildren();
}
function renderResults(s) {
  const nextKey =
    s.phase === "finished"
      ? "finished"
      : s.phase === "results"
        ? "round-" + s.round
        : "empty";
  if (viewKey !== nextKey) {
    $("results").replaceChildren();
    viewKey = nextKey;
  }
  $("results-title").hidden = nextKey === "empty";
  $("results-title").textContent =
    s.phase === "finished"
      ? "Твои ответы"
      : "Подписи этого раунда";
  for (const r of s.results) {
    if (document.getElementById("result-" + r.id)) continue;
    const article = document.createElement("article");
    article.id = "result-" + r.id;
    const title = document.createElement("h3");
    title.textContent = `Раунд ${r.round} · ${r.name} · ${r.score}/100`;
    const caption = document.createElement("p");
    caption.textContent = r.caption || "Без ответа";
    const explanation = document.createElement("p");
    explanation.textContent = r.verdict + " — " + r.explanation;
    article.append(title, caption, explanation);
    if (s.phase === "finished" && r.player === s.you && r.caption) {
      const input = document.createElement("textarea");
      input.maxLength = 1000;
      input.value = r.comment || "";
      input.placeholder = "Пояснение к ответу";
      const button = document.createElement("button");
      button.textContent = "Сохранить пояснение";
      const note = document.createElement("small");
      button.onclick = async () => {
        button.disabled = true;
        try {
          await api("feedback", { id: r.id, comment: input.value });
          note.textContent = "Сохранено.";
        } catch (e) {
          error(e);
        } finally {
          button.disabled = false;
        }
      };
      article.append(input, button, note);
    }
    $("results").prepend(article);
  }
}
function resetGallery() {
  galleryRequest++;
  galleryRound = 0;
  $("gallery").hidden = true;
  $("gallery-photo").removeAttribute("src");
  $("gallery-photo").hidden = true;
  $("gallery-winners").replaceChildren();
}
function renderGallery(s) {
  if (s.phase !== "finished") {
    if (galleryRound) resetGallery();
    return;
  }
  $("gallery").hidden = false;
  if (!galleryRound) {
    $("gallery-select").replaceChildren(
      ...s.gallery.map((item) => {
        const option = document.createElement("option");
        option.value = item.round;
        option.textContent = item.round;
        return option;
      }),
    );
    void showGallery(1);
  }
}
async function showGallery(round) {
  if (state?.phase !== "finished") return;
  const item = state.gallery.find((x) => x.round === round);
  if (!item) return;
  galleryRound = round;
  const request = ++galleryRequest;
  $("gallery-select").value = round;
  $("gallery-position").textContent = `${round} / ${state.count}`;
  $("gallery-prev").disabled = round === 1;
  $("gallery-next").disabled = round === state.count;
  $("gallery-photo").hidden = true;
  $("gallery-photo").removeAttribute("src");
  $("gallery-status").textContent = "Загружаем кадр…";
  $("gallery-winners").replaceChildren(
    ...item.winners.map((w) => {
      const card = document.createElement("article");
      const name = document.createElement("small");
      name.textContent = `${w.name} · ${w.score}/100`;
      const text = document.createElement("p");
      text.textContent = w.caption;
      card.append(name, text);
      return card;
    }),
  );
  try {
    const data = await api("gallery", { round });
    if (request !== galleryRequest || state?.phase !== "finished") return;
    $("gallery-photo").onload = () => {
      if (request === galleryRequest) {
        $("gallery-photo").hidden = false;
        $("gallery-status").textContent =
          item.winners.length === 0
            ? "В этом раунде никто не отправил ответ."
            : item.winners.length > 1
              ? "Ничья"
              : "";
      }
    };
    $("gallery-photo").onerror = () => {
      if (request === galleryRequest)
        $("gallery-status").textContent =
          "Не удалось показать фото. Выбери раунд ещё раз.";
    };
    $("gallery-photo").src = data.image;
  } catch (e) {
    if (request === galleryRequest) $("gallery-status").textContent = e.message;
  }
}
$("gallery-prev").onclick = () => showGallery(galleryRound - 1);
$("gallery-next").onclick = () => showGallery(galleryRound + 1);
$("gallery-select").onchange = () =>
  showGallery(Number($("gallery-select").value));
async function gate() {
  try {
    const info = await api("info");
    if (player) return;
    $("game").hidden = true;
    $("leave").hidden = true;
    $("gate").hidden = info.available;
    $("join").hidden = !info.available;
    $("gate-title").textContent =
      info.phase === "lobby"
        ? "Все места заняты"
        : info.phase === "abandoned"
          ? "Все игроки вышли"
          : "Сейчас нельзя подключиться";
    $("gate-text").textContent =
      info.phase === "lobby"
        ? "В лобби уже 5 игроков. Подождите, пока освободится место."
        : info.phase === "abandoned"
          ? "Эта комната больше не используется."
          : info.phase === "finished"
            ? "Игра завершена. Подождите, пока хост откроет новое лобби."
            : `Игра уже идёт. Раунд ${Math.max(1, info.round)} из ${info.count}. Подождите — вход откроется в новом лобби.`;
  } catch (e) {
    $("join").hidden = true;
    $("gate").hidden = false;
    $("gate-title").textContent = "Комната недоступна";
    $("gate-text").textContent = e.message;
  }
}
async function poll() {
  clearTimeout(pollTimer);
  if (!player) {
    await gate();
    if (player) return;
    pollTimer = setTimeout(poll, 3000);
    return;
  }
  const current = player;
  try {
    const s = await api("state");
    if (player !== current) return;
    error();
    render(s);
  } catch (e) {
    error(e);
    if (/закрыта|Войди/.test(e.message)) {
      player = null;
      sessionStorage.removeItem("room-player-" + room);
      await gate();
    }
  }
  pollTimer = setTimeout(poll, 2000);
}
$("join").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const s = await api("join", { name: $("name").value });
    player = s.player;
    sessionStorage.setItem("room-player-" + room, player);
    render(s);
    error();
    poll();
  } catch (e) {
    error(e);
    await gate();
  }
};
async function action(name, b = {}) {
  if (pending) return;
  pending = true;
  try {
    const result = await api(name, b);
    error();
    render(result);
  } catch (e) {
    error(e);
  } finally {
    pending = false;
  }
}
$("start").onclick = () =>
  action("start", { count: Number($("count").value), style: $("style").value });
$("answer").onsubmit = (e) => {
  e.preventDefault();
  if (Array.from($("caption").value.trim()).length > 50)
    return error(Error("До 50 символов."));
  action("answer", { round: state.round, answer: $("caption").value });
};
$("leave").onclick = async () => {
  try {
    await api("leave");
    player = null;
    state = null;
    lastImage = 0;
    resetGallery();
    sessionStorage.removeItem("room-player-" + room);
    $("results").replaceChildren();
    viewKey = "";
    $("notice").textContent = "Ты вышел из комнаты.";
    await poll();
  } catch (e) {
    error(e);
  }
};
$("again").onclick = () => {
  lastImage = 0;
  action("again");
};
$("retry").onclick = () => action("retry");
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(copyLink);
    $("notice").textContent = "Приглашение скопировано.";
  } catch {
    $("link").select();
    $("notice").textContent = "Ссылка выделена — скопируй её.";
  }
};
$("create").onclick = async () => {
  try {
    const s = await api("create");
    location.href = "/group#room=" + s.room;
    location.reload();
  } catch (e) {
    error(e);
  }
};
setInterval(() => {
  if (!state) return;
  const seconds = Math.max(
    0,
    Math.ceil((state.deadline - Date.now() - offset) / 1000),
  );
  $("phase-clock").textContent =
    state.phase === "results"
      ? ` ${state.round >= state.count ? "Итоги игры" : "Следующий раунд"} через ${seconds} с`
      : state.phase === "answering"
        ? `${seconds} с`
        : "";
  $("timer").textContent = state.submitted
    ? "Ответ принят"
    : `Осталось ${seconds} сек.`;
  if (state.phase === "answering" && !seconds) $("submit").disabled = true;
}, 250);
$("link").value = copyLink;
if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
  fetch("/api/share/status")
    .then((r) => r.json())
    .then((s) => {
      if (s.phase === "ready") {
        copyLink = new URL(s.link).origin + "/group#room=" + room;
        $("link").value = copyLink;
      } else
        $("notice").textContent =
          "Для приглашения через интернет включи «Другие устройства» на главной странице.";
    })
    .catch(() => {});
}
poll();
