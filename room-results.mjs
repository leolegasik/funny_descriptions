// Only submitted answers compete; a skipped round has no winning caption.
export function roundHighlights(results, count) {
  return Array.from({ length: count }, (_, index) => {
    const round = index + 1;
    const answers = results.filter(
      (item) => item.round === round && item.caption,
    );
    const score = answers.length
      ? Math.max(...answers.map((item) => item.score))
      : null;
    return {
      round,
      score,
      winners: answers
        .filter((item) => item.score === score)
        .map(({ player, name, caption, score }) => ({
          player,
          name,
          caption,
          score,
        })),
    };
  });
}
export const imageData = (image) =>
  image ? `data:${image.mime};base64,${image.bytes.toString("base64")}` : null;
