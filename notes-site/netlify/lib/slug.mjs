// Shared with the browser (public/slug.js is a copy). Keep them identical.
export function slugify(title) {
  return String(title)
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[\/\\?#%<>"|*:^\[\]{}]/g, "")
    .slice(0, 200);
}

// [[Target]] or [[Target|label]]
export const WIKILINK_RE = /\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]+?))?\]\]/g;

export function outgoingSlugs(body) {
  const out = new Set();
  for (const m of String(body).matchAll(WIKILINK_RE)) out.add(slugify(m[1]));
  return out;
}
