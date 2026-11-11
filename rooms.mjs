import { randomBytes, randomUUID } from "node:crypto";
import { roundHighlights, imageData } from "./room-results.mjs";
const ROOM_TTL = 120000,
  ANSWER_TIME = 60000,
  REVIEW_TIME = 10000,
  MAX_ROOMS = 12,
  MAX_PLAYERS = 5;
const key = () => randomBytes(32).toString("base64url");
const colors = ["#b44b45", "#3267ad", "#39815b", "#9564b5", "#a57520"];
export function createRooms({ photo, judge, feedback, now = Date.now }) {
  const rooms = new Map();
  const alive = (r) => now() - r.touched < ROOM_TTL;
  function get(id) {
    const r = rooms.get(id);
    if (!r || !alive(r)) {
      rooms.delete(id);
      throw Error("Комната закрыта после двух минут без игроков.");
    }
    return r;
  }
  function member(r, token) {
    const p = r.players.find((p) => p.token === token && !p.left);
    if (!p) throw Error("Войди в лобби.");
    return p;
  }
  function host(r, p) {
    if (r.host !== p.id) throw Error("Это действие доступно только хосту.");
  }
  function view(r, p, includeImage = true) {
    return {
      room: r.id,
      you: p.id,
      host: r.host,
      phase: r.phase,
      round: r.round,
      count: r.count,
      style: r.style,
      deadline: r.deadline,
      serverTime: now(),
      error: r.error || "",
      gallery:
        r.phase === "finished" ? roundHighlights(r.results, r.count) : [],
      image: includeImage ? imageData(r.image) : null,
      standings: r.players.map((x) => ({
        id: x.id,
        name: x.name,
        total: x.total,
        left: !!x.left,
      })),
      players: r.players
        .filter((x) => !x.left)
        .map((x) => ({
          id: x.id,
          name: x.name,
          color: x.color,
          online: now() - x.seen < 15000,
          ready: x.answer !== null,
          total: x.total,
        })),
      results: r.results
        .filter((x) =>
          r.phase === "finished"
            ? x.player === p.id
            : r.phase === "results" && x.round === r.round,
        )
        .map((x) => ({
          ...x,
          comment: x.player === p.id ? x.comment : undefined,
        })),
      submitted: p.answer !== null,
    };
  }
  async function next(r) {
    r.phase = "loading";
    r.error = "";
    r.image = null;
    for (const p of r.players) p.answer = p.left ? "" : null;
    try {
      const image = await photo();
      if (!rooms.has(r.id) || !alive(r) || r.phase === "abandoned") return;
      r.image = image;
      r.photos.push(image);
      r.round++;
      r.deadline = now() + ANSWER_TIME;
      r.phase = "answering";
    } catch (e) {
      if (!rooms.has(r.id) || r.phase === "abandoned") return;
      r.phase = "error";
      r.error = e.message;
      r.retry = "photo";
    }
  }
  async function evaluate(r) {
    if (r.phase !== "answering") return;
    r.phase = "judging";
    try {
      for (const p of r.players) {
        if (!rooms.has(r.id) || !alive(r) || r.phase === "abandoned") return;
        if (r.results.some((x) => x.round === r.round && x.player === p.id))
          continue;
        const caption = p.answer || "";
        const result = caption
          ? await judge(
              r.image,
              caption,
              r.style,
              () => rooms.has(r.id) && alive(r) && r.phase !== "abandoned",
            )
          : {
              id: randomUUID(),
              score: 0,
              comment: p.left ? "Игрок вышел" : "Нет ответа за минуту",
              explanation: p.left
                ? "За пропущенный раунд — 0 баллов."
                : "Время вышло.",
            };
        if (!rooms.has(r.id) || r.phase === "abandoned") return;
        p.total += result.score;
        r.results.push({
          round: r.round,
          player: p.id,
          name: p.name,
          caption,
          score: result.score,
          explanation: result.explanation,
          verdict: result.comment,
          id: result.id,
        });
      }
      r.phase = "results";
      r.deadline = now() + REVIEW_TIME;
    } catch (e) {
      if (!rooms.has(r.id) || r.phase === "abandoned") return;
      r.phase = "error";
      r.error = e.message;
      r.retry = "judge";
    }
  }
  const tick = setInterval(() => {
    for (const [id, r] of rooms) {
      if (!alive(r)) {
        rooms.delete(id);
        continue;
      }
      if (r.phase === "answering" && now() >= r.deadline) void evaluate(r);
      if (r.phase === "results" && now() >= r.deadline) {
        if (r.round >= r.count) r.phase = "finished";
        else void next(r);
      }
    }
  }, 500);
  tick.unref();
  return {
    close() {
      clearInterval(tick);
      rooms.clear();
    },
    async call(action, b, creator) {
      if (action === "create") {
        if (creator === "guest") {
          const parent = get(b.room);
          creator = member(parent, b.player).token;
        }
        for (const [id, r] of rooms) if (!alive(r)) rooms.delete(id);
        const existing = [...rooms.values()].find((r) => r.creator === creator);
        if (existing) return { room: existing.id };
        if (rooms.size >= MAX_ROOMS)
          throw Error(
            "Слишком много активных комнат. Дождись закрытия свободных.",
          );
        const id = key();
        rooms.set(id, {
          id,
          creator,
          touched: now(),
          players: [],
          host: null,
          phase: "lobby",
          round: 0,
          count: 5,
          style: "normal",
          results: [],
          photos: [],
        });
        return { room: id };
      }
      const r = get(b.room);
      if (action === "info")
        return {
          phase: r.phase,
          round: r.round,
          count: r.count,
          full: r.players.filter((x) => !x.left).length >= 5,
          available:
            r.phase === "lobby" && r.players.filter((x) => !x.left).length < 5,
        };
      if (action === "join") {
        const old = r.players.find((p) => p.token === b.player && !p.left);
        if (old) {
          old.seen = now();
          r.touched = now();
          return { player: old.token, ...view(r, old) };
        }
        if (r.phase !== "lobby")
          throw Error("Игра уже началась. Дождись новой игры.");
        if (r.players.length >= MAX_PLAYERS)
          throw Error("В комнате уже пять игроков.");
        const name = typeof b.name === "string" ? b.name.trim() : "";
        if (!name || Array.from(name).length > 20)
          throw Error("Ник: от 1 до 20 символов.");
        if (r.players.some((p) => p.name.toLowerCase() === name.toLowerCase()))
          throw Error("Этот ник уже занят.");
        const p = {
          id: randomUUID(),
          token: key(),
          name,
          color: colors.find(
            (c) => !r.players.some((x) => !x.left && x.color === c),
          ),
          answer: null,
          total: 0,
          seen: now(),
        };
        r.players.push(p);
        r.host ||= p.id;
        r.touched = now();
        return { player: p.token, ...view(r, p) };
      }
      const p = member(r, b.player);
      p.seen = now();
      r.touched = now();
      if (action === "gallery") {
        if (r.phase !== "finished") throw Error("Галерея доступна после игры.");
        if (
          !Number.isInteger(b.round) ||
          b.round < 1 ||
          b.round > r.photos.length
        )
          throw Error("Такого раунда нет.");
        return { round: b.round, image: imageData(r.photos[b.round - 1]) };
      }
      if (action === "leave") {
        p.left = true;
        if (p.answer === null) p.answer = "";
        if (r.phase === "lobby") r.players = r.players.filter((x) => !x.left);
        if (r.host === p.id)
          r.host = r.players.find((x) => !x.left)?.id || null;
        if (!r.players.some((x) => !x.left)) {
          r.phase = "abandoned";
          r.image = null;
          r.photos = [];
        } else if (
          r.phase === "answering" &&
          r.players.every((x) => x.answer !== null)
        )
          void evaluate(r);
        return { left: true };
      }
      if (action === "start") {
        host(r, p);
        if (r.phase !== "lobby") throw Error("Игра уже запущена.");
        if (
          r.players.length < 2 ||
          r.players.length > MAX_PLAYERS ||
          r.players.filter((x) => now() - x.seen < 15000).length < 2
        )
          throw Error("Нужны от двух до пяти игроков онлайн.");
        if (
          ![5, 10, 20].includes(b.count) ||
          !["normal", "kind", "hard"].includes(b.style)
        )
          throw Error("Проверь настройки игры.");
        r.count = b.count;
        r.style = b.style;
        void next(r);
      } else if (action === "answer") {
        if (
          b.round !== r.round ||
          r.phase !== "answering" ||
          now() >= r.deadline
        )
          throw Error("Время ответа закончилось.");
        if (p.answer !== null) throw Error("Ответ уже принят.");
        const answer = typeof b.answer === "string" ? b.answer.trim() : "";
        if (Array.from(answer).length > 50 || /[\r\n]/.test(answer))
          throw Error("Подпись: до 50 символов, одна строка.");
        p.answer = answer;
        if (r.players.every((x) => x.answer !== null)) void evaluate(r);
      } else if (action === "again") {
        host(r, p);
        if (r.phase !== "finished") throw Error("Дождись конца игры.");
        r.players = r.players.filter((x) => !x.left);
        r.phase = "lobby";
        r.round = 0;
        r.results = [];
        r.photos = [];
        r.image = null;
        for (const x of r.players) {
          x.total = 0;
          x.answer = null;
        }
      } else if (action === "retry") {
        host(r, p);
        if (r.phase !== "error") throw Error("Повтор не нужен.");
        if (r.retry === "photo") void next(r);
        else {
          r.phase = "answering";
          void evaluate(r);
        }
      } else if (action === "feedback") {
        const item = r.results.find((x) => x.id === b.id && x.player === p.id);
        if (!item || !item.caption) throw Error("Оценка не найдена.");
        if (
          typeof b.comment !== "string" ||
          Array.from(b.comment).length > 1000
        )
          throw Error("Пояснение: до 1000 символов.");
        await feedback(item.id, b.comment.trim());
        item.comment = b.comment.trim();
      } else if (action !== "state") throw Error("Неизвестное действие.");
      return view(r, p, b.imageRound !== r.round);
    },
  };
}
