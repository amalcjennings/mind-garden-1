// Exercises every API route. Run `npm run dev` first, then `npm test`.
// Against a live site: BASE=https://your-site.netlify.app EDIT_PASSWORD=... npm test
// (it creates, then permanently deletes, notes whose titles start with "Smoke test").
import assert from "node:assert/strict";

const BASE = process.env.BASE || "http://localhost:8888";
const PW = process.env.EDIT_PASSWORD || "dev";

async function call(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${PW}`;
  const res = await fetch(BASE + "/api" + path, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
const step = (name) => console.log("✓", name);
const A = "Smoke_test_A", B = "Smoke_test_B", C = "Smoke_test_C";

// Clear anything a previous, interrupted run left behind.
for (const s of [A, B, C, "Smoke_test_D"]) {
  await call(`/notes/${s}`, { method: "DELETE" });
  await call(`/deleted/${s}`, { method: "DELETE" });
}

let r = await call("/notes", { auth: false });
assert.equal(r.status, 200);
assert.ok(r.data.notes.length > 0, "seed notes exist");
assert.equal(r.data.editable, true);
step(`list notes (${r.data.notes.length})`);

r = await call("/login", { method: "POST", auth: false });
assert.equal(r.status, 401);
r = await call("/login", { method: "POST" });
assert.equal(r.status, 200);
step("login rejects missing password, accepts right one");

r = await call(`/notes/${A}`, { method: "PUT", auth: false, body: { title: "Smoke test A", body: "x" } });
assert.equal(r.status, 401);
step("writes need the password");

r = await call(`/notes/${A}`, { method: "PUT", body: { title: "Smoke test A", body: "Links to [[Smoke test B]].", baseUpdated: null } });
assert.equal(r.status, 201);
const a1 = r.data.note;
r = await call(`/notes/${B}`, { method: "PUT", body: { title: "Smoke test B", body: "Hello", baseUpdated: null } });
assert.equal(r.status, 201);
step("create notes");

r = await call(`/notes/${A}`, { method: "PUT", body: { title: "Smoke test A", body: "dup", baseUpdated: null } });
assert.equal(r.status, 409, "creating over an existing note conflicts");
r = await call(`/notes/${A}`, { method: "PUT", body: { title: "Smoke test A", body: "Edited, still links [[Smoke test B|bee]].", baseUpdated: a1.updated } });
assert.equal(r.status, 200);
r = await call(`/notes/${A}`, { method: "PUT", body: { title: "Smoke test A", body: "stale", baseUpdated: a1.updated } });
assert.equal(r.status, 409);
assert.ok(r.data.current.body.startsWith("Edited"));
step("edit + conflict detection");

r = await call(`/notes/${A}/history`);
assert.equal(r.data.revisions.length, 1);
const rev = await call(`/notes/${A}/history/${r.data.revisions[0].id}`);
assert.equal(rev.data.revision.body, "Links to [[Smoke test B]].");
step("history keeps previous version");

r = await call(`/notes/${B}/rename`, { method: "POST", body: { title: "Smoke test C", updateLinks: true } });
assert.equal(r.status, 200);
assert.equal(r.data.note.slug, C);
assert.equal(r.data.removed, B);
r = await call(`/notes/${A}`);
assert.equal(r.data.note.body, "Edited, still links [[Smoke test C|bee]].");
r = await call(`/notes/${B}`);
assert.equal(r.status, 404);
step("rename moves note and rewrites links");

r = await call(`/notes/${C}`, { method: "DELETE" });
assert.equal(r.status, 200);
r = await call("/deleted");
const gone = r.data.deleted.find((d) => d.slug === C);
assert.ok(gone, "deleted note is listed");
const old = await call(`/notes/${C}/history/${gone.id}`);
r = await call(`/notes/${C}`, { method: "PUT", body: { title: old.data.revision.title, body: old.data.revision.body, baseUpdated: null } });
assert.equal(r.status, 201);
step("delete + restore from deleted list");

r = await call("/import", { method: "POST", body: { notes: [{ title: "Smoke test A", body: "imported" }, { title: "Smoke test D", body: "new" }] } });
assert.deepEqual(r.data, { created: 1, updated: 1 });
step("import");

r = await call(`/notes/${B}/history`);
assert.equal(r.data.revisions.length, 0, "rename moved history away from the old address");
for (const s of [A, C, "Smoke_test_D"]) {
  await call(`/notes/${s}`, { method: "DELETE" });
  r = await call(`/deleted/${s}`, { method: "DELETE" });
  assert.equal(r.status, 200);
}
r = await call("/deleted");
assert.ok(!r.data.deleted.some((d) => d.slug.startsWith("Smoke_test")), "purged notes are gone");
step("cleanup");
console.log("All API checks passed.");
