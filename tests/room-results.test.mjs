import test from "node:test";
import assert from "node:assert/strict";
import { roundHighlights } from "../room-results.mjs";
test("gallery: ties, all skipped, a submitted zero, order and no private feedback", () => {
  const row = (round, name, score, caption) => ({
    round,
    player: name,
    name,
    score,
    caption,
    comment: "PRIVATE",
    token: "PRIVATE",
  });
  const gallery = roundHighlights(
    [
      row(1, "a", 70, "one"),
      row(1, "b", 70, "two"),
      row(1, "c", 20, "weak"),
      row(2, "a", 0, ""),
      row(3, "a", 0, "zero"),
      row(3, "b", 0, ""),
    ],
    3,
  );
  assert.deepEqual(
    gallery.map((x) => x.round),
    [1, 2, 3],
  );
  assert.deepEqual(
    gallery[0].winners.map((x) => x.caption),
    ["one", "two"],
  );
  assert.equal(gallery[0].score, 70);
  assert.deepEqual(gallery[1], { round: 2, score: null, winners: [] });
  assert.deepEqual(
    gallery[2].winners.map((x) => x.caption),
    ["zero"],
  );
  assert.ok(!JSON.stringify(gallery).includes("PRIVATE"));
});
