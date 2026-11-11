import test from "node:test";
import assert from "node:assert/strict";
import { createRooms } from "../rooms.mjs";
const wait = () => new Promise((r) => setTimeout(r, 550));
test("rooms: permissions, limits, hidden answers, minute deadline, totals, feedback, replay and expiry", async () => {
  let time = 1000,
    calls = 0,
    notes = [],
    photos = 0;
  const rooms = createRooms({
    now: () => time,
    photo: async () => ({
      bytes: Buffer.from("photo" + ++photos),
      mime: "image/jpeg",
    }),
    judge: async (image, caption, style) => {
      calls++;
      assert.equal(style, "hard");
      return { id: "v" + calls, score: 70, comment: "ok", explanation: "ok" };
    },
    feedback: async (...a) => notes.push(a),
  });
  try {
    const { room } = await rooms.call("create", {}, "owner");
    assert.equal((await rooms.call("create", {}, "owner")).room, room);
    const a = await rooms.call("join", { room, name: "А" });
    const b = await rooms.call("join", { room, name: "Б" });
    const call = (action, extra = {}, player = a.player) =>
      rooms.call(action, { room, player, ...extra });
    await assert.rejects(
      call("start", { count: 5, style: "hard" }, b.player),
      /хост/,
    );
    for (let i = 0; i < 3; i++)
      await rooms.call("join", { room, name: "P" + i });
    await assert.rejects(rooms.call("join", { room, name: "Шестой" }), /пять/);
    await assert.rejects(call("gallery", { round: 1 }), /после игры/);
    await call("start", { count: 5, style: "hard" });
    await new Promise((r) => setTimeout(r, 0));
    for (let round = 1; round <= 5; round++) {
      await call("answer", { round, answer: "Подпись " + round });
      const before = await call("state", {}, b.player);
      assert.equal(
        before.results.some((x) => x.round === round),
        false,
      );
      assert.equal(before.players[0].ready, true);
      assert.ok(!JSON.stringify(before).includes("Подпись " + round));
      await assert.rejects(call("answer", { round, answer: "Ещё" }), /принят/);
      time += 60001;
      await call("state");
      await wait();
      const after = await call("state");
      assert.equal(after.results.filter((x) => x.round === round).length, 5);
      assert.equal(after.players[0].total, 70 * round);
      assert.equal(after.players[1].total, 0);
      if (round < 5) {
        time += 10001;
        await call("state");
        await wait();
      }
    }
    time += 10001;
    await call("state");
    await wait();
    let final = await call("state");
    assert.equal(final.phase, "finished");
    assert.equal(calls, 5);
    assert.equal(final.gallery.length, 5);
    assert.ok(!JSON.stringify(final.gallery).includes("image"));
    for (let round = 1; round <= 5; round++) {
      const frame = await call("gallery", { round }, b.player);
      assert.equal(
        frame.image,
        "data:image/jpeg;base64," +
          Buffer.from("photo" + round).toString("base64"),
      );
      assert.equal(
        final.gallery[round - 1].winners[0].caption,
        "Подпись " + round,
      );
    }
    await assert.rejects(call("gallery", { round: 0 }));
    await assert.rejects(call("gallery", { round: 6 }));
    await assert.rejects(call("gallery", { round: 1 }, "wrong"), /Войди/);
    await call("feedback", { id: "v1", comment: "Отсылка" });
    assert.deepEqual(notes, [["v1", "Отсылка"]]);
    await assert.rejects(
      call("feedback", { id: "v1", comment: "Чужое" }, b.player),
      /найдена/,
    );
    await assert.rejects(call("rejudge"), /Неизвестное/);
    await call("again");
    final = await call("state");
    assert.equal(final.phase, "lobby");
    assert.equal(final.players[0].total, 0);
    assert.equal(final.players[0].color, a.players[0].color);
    assert.deepEqual(final.gallery, []);
    await assert.rejects(call("gallery", { round: 1 }));
    const child = await rooms.call(
      "create",
      { room, player: b.player },
      "guest",
    );
    assert.notEqual(child.room, room);
    await assert.rejects(rooms.call("create", {}, "guest"));
    time += 120001;
    await assert.rejects(call("state"), /закрыта/);
  } finally {
    rooms.close();
  }
});
test("all submissions start judging immediately and errors do not double score", async () => {
  let fail = true,
    calls = 0;
  const rooms = createRooms({
    photo: async () => ({ bytes: Buffer.from("x"), mime: "image/jpeg" }),
    judge: async () => {
      calls++;
      if (calls === 2 && fail) throw Error("offline");
      return { id: "x" + calls, score: 50 };
    },
    feedback: async () => {},
  });
  try {
    const { room } = await rooms.call("create", {}, "x");
    const a = await rooms.call("join", { room, name: "a" });
    const b = await rooms.call("join", { room, name: "b" });
    const call = (action, extra = {}, player = a.player) =>
      rooms.call(action, { room, player, ...extra });
    await assert.rejects(call("start", { count: 6, style: "hard" }));
    await call("start", { count: 5, style: "kind" });
    await new Promise((r) => setTimeout(r, 0));
    await call("answer", { round: 1, answer: "a" });
    await call("answer", { round: 1, answer: "b" }, b.player);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((await call("state")).phase, "error");
    fail = false;
    await call("retry");
    await new Promise((r) => setTimeout(r, 0));
    const s = await call("state");
    assert.equal(s.phase, "results");
    assert.deepEqual(
      s.players.map((x) => x.total),
      [50, 50],
    );
    assert.equal(calls, 3);
  } finally {
    rooms.close();
  }
});

test("entry status, leaving, host transfer, stable colors and zero scores without waiting", async () => {
  let time = 1000,
    calls = 0;
  const rooms = createRooms({
    now: () => time,
    photo: async () => ({ bytes: Buffer.from("x"), mime: "image/jpeg" }),
    judge: async () => ({ id: "r" + ++calls, score: 60 }),
    feedback: async () => {},
  });
  try {
    const { room } = await rooms.call("create", {}, "owner");
    const a = await rooms.call("join", { room, name: "a" }),
      b = await rooms.call("join", { room, name: "b" });
    const call = (action, extra = {}, player = b.player) =>
      rooms.call(action, { room, player, ...extra });
    assert.equal((await call("info", {}, null)).available, true);
    await call("leave", {}, a.player);
    let s = await call("state");
    assert.equal(s.host, b.you);
    assert.equal(s.players.length, 1);
    assert.equal(s.players[0].color, b.players[1].color);
    await assert.rejects(call("state", {}, a.player), /Войди/);
    const c = await rooms.call("join", { room, name: "c" });
    assert.notEqual(c.players[1].color, s.players[0].color);
    await call("start", { count: 5, style: "normal" });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal((await call("info", {}, null)).available, false);
    await assert.rejects(
      rooms.call("join", { room, name: "late" }),
      /началась/,
    );
    await call("leave", {}, c.player);
    s = await call("state");
    assert.equal(s.players.length, 1);
    assert.equal(s.standings.length, 2);
    for (let round = 1; round <= 5; round++) {
      await call("answer", { round, answer: "text" });
      await new Promise((r) => setTimeout(r, 0));
      s = await call("state");
      assert.equal(s.phase, "results");
      assert.equal(s.deadline - time, 10000);
      assert.equal(s.standings.find((x) => x.id === c.you).total, 0);
      if (round < 5) {
        assert.ok(s.results.every((x) => x.round === round));
        time += 10001;
        await wait();
      }
    }
    time += 10001;
    await wait();
    s = await call("state");
    assert.equal(s.phase, "finished");
    assert.ok(s.results.every((x) => x.player === b.you));
    assert.equal(s.results.length, 5);
    assert.equal(calls, 5);
    await call("again");
    s = await call("state");
    assert.equal(s.players.length, 1);
    assert.equal((await call("info", {}, null)).available, true);
    await call("leave");
    assert.equal((await call("info", {}, null)).phase, "abandoned");
    time += 120001;
    await assert.rejects(call("info", {}, null), /закрыта/);
  } finally {
    rooms.close();
  }
});
test("full lobby status clears immediately on leave", async () => {
  const rooms = createRooms({
    photo: async () => {},
    judge: async () => {},
    feedback: async () => {},
  });
  try {
    const { room } = await rooms.call("create", {}, "owner");
    let player;
    for (let i = 0; i < 5; i++)
      player = (await rooms.call("join", { room, name: String(i) })).player;
    assert.equal((await rooms.call("info", { room })).full, true);
    await rooms.call("leave", { room, player });
    assert.equal((await rooms.call("info", { room })).available, true);
  } finally {
    rooms.close();
  }
});
