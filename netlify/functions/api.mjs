import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { slugify, WIKILINK_RE } from "../lib/slug.mjs";
import { SEED_NOTES } from "../lib/seed.mjs";

export const config = { path: "/api/*" };

const MAX_NOTE_BYTES = 1_000_000;
const MAX_REVISIONS = 50;

const notes = () => getStore({ name: "notes", consistency: "strong" });
const history = () => getStore({ name: "notes-history", consistency: "strong" });
const meta = () => getStore({ name: "notes-meta", consistency: "strong" });

const key = (slug) => encodeURIComponent(slug);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fail = (status, error) => json({ error }, status);

function editPassword() {
  return process.env.EDIT_PASSWORD || "";
}

function hash(s) {
  return createHash("sha256").update(s).digest();
}

function checkAuth(req) {
  const pw = editPassword();
  if (!pw) {
    return fail(403, "Editing is disabled. Set the EDIT_PASSWORD environment variable in Netlify and redeploy.");
  }
  const header = req.headers.get("authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!given || !timingSafeEqual(hash(given), hash(pw))) return fail(401, "Wrong password.");
  return null;
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_NOTE_BYTES * 20) throw new HttpError(413, "Request too large.");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getNote(slug) {
  return notes().get(key(slug), { type: "json" });
}

async function listAll() {
  const store = notes();
  const { blobs } = await store.list();
  const out = [];
  for (let i = 0; i < blobs.length; i += 50) {
    const chunk = await Promise.all(blobs.slice(i, i + 50).map((b) => store.get(b.key, { type: "json" })));
    out.push(...chunk.filter(Boolean));
  }
  return out;
}

async function seedIfEmpty() {
  const m = meta();
  if (await m.get("seeded")) return false;
  const { blobs } = await notes().list();
  if (blobs.length === 0) {
    const now = new Date().toISOString();
    await Promise.all(
      SEED_NOTES.map((n) => {
        const slug = slugify(n.title);
        return notes().setJSON(key(slug), { slug, title: n.title, body: n.body, created: now, updated: now });
      })
    );
  }
  await m.set("seeded", new Date().toISOString());
  return true;
}

async function saveRevision(note, reason) {
  const id = `${Date.now().toString().padStart(15, "0")}-${randomBytes(3).toString("hex")}`;
  const h = history();
  await h.setJSON(`${key(note.slug)}/${id}`, { ...note, reason, savedAt: new Date().toISOString() });
  const { blobs } = await h.list({ prefix: `${key(note.slug)}/` });
  const sorted = blobs.map((b) => b.key).sort();
  const excess = sorted.slice(0, Math.max(0, sorted.length - MAX_REVISIONS));
  await Promise.all(excess.map((k) => h.delete(k)));
}

function validateNote(title, body) {
  if (typeof title !== "string" || !slugify(title)) throw new HttpError(400, "A title is required.");
  if (typeof body !== "string") throw new HttpError(400, "Body must be a string.");
  if (Buffer.byteLength(body) > MAX_NOTE_BYTES) throw new HttpError(413, "Note is larger than 1 MB.");
}

function rewriteLinks(body, fromSlug, toTitle) {
  return body.replace(WIKILINK_RE, (whole, target, label) => {
    if (slugify(target) !== fromSlug) return whole;
    return label ? `[[${toTitle}|${label}]]` : `[[${toTitle}]]`;
  });
}

async function putNote(slug, payload) {
  const { title, body, baseUpdated } = payload;
  validateNote(title, body);
  if (slugify(title) !== slug) throw new HttpError(400, "Title does not match this note's address. Use rename instead.");
  const existing = await getNote(slug);
  if (existing) {
    // baseUpdated === null means "I believe this is a new note".
    if (baseUpdated !== undefined && baseUpdated !== existing.updated) {
      return json({ error: "This note was changed elsewhere since you opened it.", current: existing }, 409);
    }
    if (existing.body === body && existing.title === title) return json({ note: existing });
    await saveRevision(existing, "edit");
  }
  const now = new Date().toISOString();
  const note = { slug, title: title.trim(), body, created: existing?.created || now, updated: now };
  await notes().setJSON(key(slug), note);
  return json({ note }, existing ? 200 : 201);
}

async function renameNote(slug, payload) {
  const existing = await getNote(slug);
  if (!existing) throw new HttpError(404, "Note not found.");
  const newTitle = String(payload.title || "").trim();
  const newSlug = slugify(newTitle);
  if (!newSlug) throw new HttpError(400, "A title is required.");
  if (newSlug !== slug && (await getNote(newSlug))) throw new HttpError(409, `A note called "${newTitle}" already exists.`);

  await saveRevision(existing, "rename");
  const now = new Date().toISOString();
  const note = { ...existing, slug: newSlug, title: newTitle, updated: now };
  await notes().setJSON(key(newSlug), note);
  if (newSlug !== slug) {
    await notes().delete(key(slug));
    await moveHistory(slug, newSlug);
  }

  const changed = [note];
  if (payload.updateLinks !== false && newSlug !== slug) {
    for (const other of await listAll()) {
      const body = rewriteLinks(other.body, slug, newTitle);
      if (body === other.body) continue;
      await saveRevision(other, `link update: ${existing.title} → ${newTitle}`);
      const updated = { ...other, body, updated: now };
      await notes().setJSON(key(other.slug), updated);
      changed.push(updated);
    }
  }
  return json({ note, changed, removed: newSlug !== slug ? slug : null });
}

async function moveHistory(fromSlug, toSlug) {
  const h = history();
  const { blobs } = await h.list({ prefix: `${key(fromSlug)}/` });
  for (const b of blobs) {
    const rev = await h.get(b.key, { type: "json" });
    if (rev) await h.setJSON(`${key(toSlug)}/${b.key.slice(key(fromSlug).length + 1)}`, rev);
    await h.delete(b.key);
  }
}

async function purgeDeleted(slug) {
  if (await getNote(slug)) throw new HttpError(409, "That note still exists. Delete it first.");
  const h = history();
  const { blobs } = await h.list({ prefix: `${key(slug)}/` });
  await Promise.all(blobs.map((b) => h.delete(b.key)));
  return json({ ok: true, removed: blobs.length });
}

async function deleteNote(slug) {
  const existing = await getNote(slug);
  if (!existing) throw new HttpError(404, "Note not found.");
  await saveRevision(existing, "delete");
  await notes().delete(key(slug));
  return json({ ok: true });
}

async function listHistory(slug) {
  const { blobs } = await history().list({ prefix: `${key(slug)}/` });
  const revisions = blobs
    .map((b) => b.key.slice(key(slug).length + 1))
    .sort()
    .reverse()
    .map((id) => ({ id, savedAt: new Date(Number(id.split("-")[0])).toISOString() }));
  return json({ revisions });
}

async function getRevision(slug, id) {
  const rev = await history().get(`${key(slug)}/${id}`, { type: "json" });
  if (!rev) throw new HttpError(404, "Revision not found.");
  return json({ revision: rev });
}

async function listDeleted() {
  const { blobs } = await history().list();
  const live = new Set((await notes().list()).blobs.map((b) => b.key));
  const latest = new Map();
  for (const b of blobs) {
    const [k, id] = b.key.split("/");
    if (live.has(k)) continue;
    if (!latest.has(k) || latest.get(k) < id) latest.set(k, id);
  }
  return json({
    deleted: [...latest].map(([k, id]) => ({
      slug: decodeURIComponent(k),
      id,
      savedAt: new Date(Number(id.split("-")[0])).toISOString(),
    })),
  });
}

async function importNotes(payload) {
  const list = Array.isArray(payload.notes) ? payload.notes : [];
  if (!list.length) throw new HttpError(400, "No notes to import.");
  let created = 0, updated = 0;
  for (const n of list) {
    validateNote(n.title, n.body);
    const slug = slugify(n.title);
    const existing = await getNote(slug);
    if (existing) {
      if (existing.body === n.body) continue;
      await saveRevision(existing, "import");
      updated++;
    } else created++;
    const now = new Date().toISOString();
    await notes().setJSON(key(slug), {
      slug, title: n.title.trim(), body: n.body,
      created: existing?.created || n.created || now, updated: now,
    });
  }
  return json({ created, updated });
}

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method;

  try {
    // Public reads
    if (method === "GET" && parts[0] === "notes" && parts.length === 1) {
      await seedIfEmpty();
      return json({ notes: await listAll(), editable: Boolean(editPassword()) });
    }
    if (method === "GET" && parts[0] === "notes" && parts.length === 2) {
      const note = await getNote(parts[1]);
      return note ? json({ note }) : fail(404, "Note not found.");
    }
    if (method === "GET" && parts[0] === "notes" && parts[2] === "history") {
      return parts.length === 4 ? await getRevision(parts[1], parts[3]) : await listHistory(parts[1]);
    }
    if (method === "GET" && parts[0] === "deleted") return await listDeleted();

    // Everything else changes data and needs the password.
    const denied = checkAuth(req);
    if (denied) return denied;

    if (method === "POST" && parts[0] === "login") return json({ ok: true });
    if (parts[0] === "notes" && parts.length === 2) {
      if (method === "PUT") return await putNote(parts[1], await readBody(req));
      if (method === "DELETE") return await deleteNote(parts[1]);
    }
    if (method === "POST" && parts[0] === "notes" && parts[2] === "rename") return await renameNote(parts[1], await readBody(req));
    if (method === "DELETE" && parts[0] === "deleted" && parts.length === 2) return await purgeDeleted(parts[1]);
    if (method === "POST" && parts[0] === "import") return await importNotes(await readBody(req));

    return fail(404, "Not found.");
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.message);
    console.error(err);
    return fail(500, "Server error: " + err.message);
  }
};
