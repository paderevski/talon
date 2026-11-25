// Avatar styles a user may pick (DiceBear style ids, drawn in the browser).
// Only styles whose art license allows this use: CC0, "free for personal and
// commercial use" (Bottts), or CC BY 4.0, where the picker shows the credit.
export const avatarStyles = [
  "lorelei",
  "notionists",
  "open-peeps",
  "adventurer",
  "big-smile",
  "fun-emoji",
  "croodles",
  "bottts",
  "pixel-art",
  "thumbs",
];

// A seed is any short id the picker makes up; it only picks the variation.
const seedPattern = /^[A-Za-z0-9_-]{1,32}$/;

// { style, seed } if valid, else null.
export function normalizeAvatar(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const style = String(value.style ?? "");
  const seed = String(value.seed ?? "");
  if (!avatarStyles.includes(style) || !seedPattern.test(seed)) {
    return null;
  }
  return { style, seed };
}
