import { marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.js";
import { slugify, WIKILINK_RE } from "/slug.js";
import { SITE } from "/config.js";

const SPINE = 40;
const $ = (sel, root = document) => root.querySelector(sel);
const $stack = $("#stack");
const $popover = $("#popover");

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  getJSON(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  setJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  notes: new Map(), // slug -> { slug, title, body, created, updated }
  backlinks: new Map(), // slug -> [{ from, context }]
  editable: false, // the server has an EDIT_PASSWORD configured
  token: storage.get("notes.token"),
  stack: [], // slugs, left to right
  pendingTitles: new Map(), // slug -> title, for links to notes that don't exist yet
  autoEdit: null, // slug to open straight into the editor
  lastFetch: 0,
};
const panes = []; // { slug, el, scroll, spine, editing }
const loggedIn = () => state.editable && Boolean(state.token);

// ---------- small helpers ----------


function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function fmtDate(iso, withTime = false) {
  if (!iso) return "";
  const opts = { year: "numeric", month: "short", day: "numeric" };
  if (withTime) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
  return new Date(iso).toLocaleString(undefined, opts);
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2500);
}

const titleFor = (slug) =>
  state.notes.get(slug)?.title ?? state.pendingTitles.get(slug) ?? slug.replace(/_/g, " ");

const isMobile = () => matchMedia("(max-width: 800px)").matches;

// ---------- API ----------

async function api(path, { method = "GET", body, token = state.token } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch("/api" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    if (res.status === 401 && path !== "/login") logout("Your session expired. Log in again to keep editing.");
    throw err;
  }
  return data;
}

const notePath = (slug, rest = "") => `/notes/${encodeURIComponent(slug)}${rest}`;

async function fetchNotes() {
  const data = await api("/notes");
  state.editable = data.editable;
  state.notes = new Map(data.notes.map((n) => [n.slug, n]));
  state.lastFetch = Date.now();
  rebuildIndex();
}

// ---------- Markdown ----------

marked.use({
  gfm: true,
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start(src) {
        const i = src.indexOf("[[");
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = /^\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]+?))?\]\]/.exec(src);
        if (m) return { type: "wikilink", raw: m[0], target: m[1].trim(), label: (m[2] ?? m[1]).trim() };
      },
      renderer(t) {
        const slug = slugify(t.target);
        const cls = "wikilink" + (state.notes.has(slug) ? "" : " missing");
        return `<a class="${cls}" href="/${encodeURIComponent(slug)}" data-slug="${esc(slug)}" data-title="${esc(t.target)}">${esc(t.label)}</a>`;
      },
    },
  ],
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    const url = new URL(node.getAttribute("href"), location.href);
    if (url.origin !== location.origin) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  }
});

const sanitize = (html) => DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
const renderMarkdown = (md) => sanitize(marked.parse(md));
const renderInline = (md) => sanitize(marked.parseInline(md));

// ---------- Backlinks ----------

function rebuildIndex() {
  const bl = new Map();
  for (const note of state.notes.values()) {
    const seen = new Set();
    for (const para of note.body.split(/\n\s*\n/)) {
      const lines = para.split("\n");
      for (const m of para.matchAll(WIKILINK_RE)) {
        const target = slugify(m[1]);
        if (target === note.slug || seen.has(target)) continue;
        seen.add(target);
        // For lists, the line is the useful context; otherwise the whole paragraph.
        const line = lines.find((l) => l.includes(m[0])) || para;
        const context = /^\s*([-*+]|\d+\.)\s/.test(line) || lines.length > 4 ? line : para;
        if (!bl.has(target)) bl.set(target, []);
        bl.get(target).push({ from: note.slug, context: trimContext(context, m[0]) });
      }
    }
  }
  state.backlinks = bl;
}

function trimContext(text, link) {
  text = text.replace(/^\s*(#+|[-*+>]|\d+\.)\s+/gm, "").replace(/\s+/g, " ").trim();
  if (text.length <= 300) return text;
  const at = text.indexOf(link);
  const start = Math.max(0, Math.min(at - 120, text.length - 300));
  // Don't cut through the middle of a [[link]].
  let s = text.slice(start, start + 300);
  s = s.replace(/^[^\[]*?\]\]/, "").replace(/\[\[[^\]]*$/, "");
  return (start > 0 ? "…" : "") + s.trim() + (start + 300 < text.length ? "…" : "");
}

// ---------- Routing ----------

function parseLocation() {
  const first = decodeURIComponent(location.pathname.slice(1)) || SITE.home;
  const rest = new URLSearchParams(location.search).getAll("stackedNotes");
  const out = [];
  for (const s of [first, ...rest]) {
    const slug = slugify(s);
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out.length ? out : [SITE.home];
}

function stackURL(stack) {
  const [first, ...rest] = stack;
  const q = rest.map((s) => "stackedNotes=" + encodeURIComponent(s)).join("&");
  const path = first === SITE.home ? "/" : "/" + encodeURIComponent(first);
  return path + (q ? "?" + q : "");
}

function navigate(stack, { replace = false, focus = stack.length - 1 } = {}) {
  state.stack = stack;
  const url = stackURL(stack);
  if (url !== location.pathname + location.search) {
    history[replace ? "replaceState" : "pushState"]({}, "", url);
  }
  renderStack();
  requestAnimationFrame(() => scrollToPane(focus));
}

function confirmDiscard(fromIndex) {
  const dirty = panes.slice(fromIndex).filter((p) => p.editing?.dirty);
  if (!dirty.length) return true;
  return confirm(`You have unsaved changes in "${titleFor(dirty[0].slug)}". Close it anyway? (Your draft is kept in this browser.)`);
}

// Open a note from pane `fromIndex` (-1 / undefined = from the header: append to the end).
function openNote(slug, { fromIndex, title, edit = false } = {}) {
  if (title && !state.notes.has(slug)) state.pendingTitles.set(slug, title);
  hidePopover();
  const existing = state.stack.indexOf(slug);
  if (existing >= 0) {
    scrollToPane(existing);
    if (edit && !panes[existing].editing) startEdit(panes[existing]);
    return;
  }
  const at = fromIndex == null || fromIndex < 0 ? state.stack.length - 1 : fromIndex;
  if (!confirmDiscard(at + 1)) return;
  if (edit || (!state.notes.has(slug) && loggedIn())) state.autoEdit = slug;
  navigate([...state.stack.slice(0, at + 1), slug]);
}

function closePane(index) {
  if (state.stack.length <= 1) return;
  if (!confirmDiscard(index) ) return;
  const next = state.stack.filter((_, i) => i !== index);
  // Keep pane objects after the removed one so their editors survive.
  const [removed] = panes.splice(index, 1);
  removed.el.remove();
  navigate(next, { focus: Math.min(index, next.length - 1) });
}

// ---------- Panes ----------

function renderStack() {
  $(".loading", $stack)?.remove();
  let i = 0;
  while (i < panes.length && i < state.stack.length && panes[i].slug === state.stack[i]) i++;
  for (const p of panes.splice(i)) p.el.remove();
  for (let j = i; j < state.stack.length; j++) {
    const p = createPane(state.stack[j]);
    panes.push(p);
    $stack.append(p.el);
  }
  panes.forEach((p, idx) => {
    p.el.style.left = idx * SPINE + "px";
    p.el.style.zIndex = idx + 1;
    p.close.hidden = panes.length === 1;
  });
  updateActiveLinks();
  updateObscured();
  const last = state.stack[state.stack.length - 1];
  document.title = `${titleFor(last)} · ${SITE.title}`;
}

function createPane(slug) {
  const p = { slug, editing: null };
  p.spine = h("div", { class: "spine", title: "Show this note", onclick: () => scrollToPane(panes.indexOf(p)) });
  p.close = h("button", { class: "pane-close", title: "Close", "aria-label": "Close note", onclick: () => closePane(panes.indexOf(p)) }, "×");
  p.scroll = h("div", { class: "pane-scroll" });
  p.el = h("section", { class: "pane" }, p.spine, p.close, p.scroll);
  renderPane(p);
  if (state.autoEdit === slug) {
    state.autoEdit = null;
    if (loggedIn()) startEdit(p);
  }
  return p;
}

// On phones only the rightmost pane is shown; this trail leads back through the stack.
function renderTrail(p) {
  const i = state.stack.indexOf(p.slug);
  if (i < 1) return null;
  return h("nav", { class: "trail", "aria-label": "Notes you came from" },
    state.stack.slice(0, i).map((slug, j) =>
      h("a", { href: stackURL(state.stack.slice(0, j + 1)), "data-trail": j }, titleFor(slug))));
}

function renderPane(p) {
  p.spine.textContent = titleFor(p.slug);
  p.trail?.remove();
  p.trail = renderTrail(p);
  if (p.trail) p.el.insertBefore(p.trail, p.scroll);
  if (p.editing) return;
  const note = state.notes.get(p.slug);
  const top = p.scroll.scrollTop;
  p.scroll.replaceChildren();

  if (loggedIn()) {
    p.scroll.append(
      h("div", { class: "note-tools" },
        note
          ? [
              h("button", { onclick: () => startEdit(p) }, "Edit"),
              h("button", { onclick: () => openHistory(p.slug) }, "History"),
              h("button", { onclick: () => openRename(p.slug) }, "Rename"),
              h("button", { class: "danger", onclick: () => openDelete(p.slug) }, "Delete"),
            ]
          : h("button", { onclick: () => startEdit(p) }, "Create this note")
      )
    );
  }

  const article = h("article", { class: "note" }, h("h1", {}, titleFor(p.slug)));
  if (note) {
    article.append(h("div", { class: "note-body", html: renderMarkdown(note.body) }));
  } else {
    article.append(
      h("p", { class: "missing-note" },
        loggedIn() ? "This note doesn't exist yet. " : "This note hasn't been written yet.",
        loggedIn() ? h("a", { href: "#", onclick: (e) => { e.preventDefault(); startEdit(p); } }, "Write it now.") : null)
    );
  }

  const links = state.backlinks.get(p.slug) || [];
  if (links.length) {
    article.append(
      h("section", { class: "backlinks" },
        h("h2", {}, `Links to this note`),
        links
          .slice()
          .sort((a, b) => titleFor(a.from).localeCompare(titleFor(b.from)))
          .map((l) =>
            h("div", { class: "backlink", "data-slug": l.from },
              h("strong", {}, titleFor(l.from)),
              h("span", { html: renderInline(l.context) }))
          ))
    );
  }
  if (note) article.append(h("div", { class: "note-meta" }, `Last edited ${fmtDate(note.updated)}`));
  p.scroll.append(article);
  p.scroll.scrollTop = top;
}

function rerenderAll() {
  panes.forEach(renderPane);
  updateActiveLinks();
  document.title = `${titleFor(state.stack[state.stack.length - 1])} · ${SITE.title}`;
}

function updateActiveLinks() {
  const open = new Set(state.stack);
  for (const a of $stack.querySelectorAll("a.wikilink")) a.classList.toggle("active", open.has(a.dataset.slug));
}

function paneWidth() {
  return panes[0]?.el.offsetWidth || 625;
}

function updateObscured() {
  if (isMobile()) return panes.forEach((p) => p.el.classList.remove("obscured"));
  panes.forEach((p, i) => {
    const next = panes[i + 1];
    const covered = next && next.el.getBoundingClientRect().left - p.el.getBoundingClientRect().left < SPINE * 2.5;
    p.el.classList.toggle("obscured", Boolean(covered));
  });
}

function scrollToPane(i, behavior = "smooth") {
  const p = panes[i];
  if (!p) return;
  if (isMobile()) return scrollTo(0, 0);
  const W = paneWidth();
  const vw = $stack.clientWidth;
  // Range of scroll positions where pane i is fully visible and not covered by pane i+1.
  const lo = (i + 1) * W - vw;
  const hi = i * (W - SPINE);
  let s = $stack.scrollLeft;
  if (s < lo) s = lo;
  if (s > hi) s = hi;
  $stack.scrollTo({ left: Math.max(0, s), behavior });
}

$stack.addEventListener("scroll", updateObscured, { passive: true });
addEventListener("resize", updateObscured);

// ---------- Clicking links ----------

$stack.addEventListener("click", (e) => {
  const paneEl = e.target.closest(".pane");
  const fromIndex = panes.findIndex((p) => p.el === paneEl);
  const a = e.target.closest("a");
  if (a?.dataset.trail) {
    e.preventDefault();
    const keep = Number(a.dataset.trail) + 1;
    if (confirmDiscard(keep)) navigate(state.stack.slice(0, keep));
    return;
  }
  if (a) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (a.closest(".editor") && !a.closest(".editor-preview")) return;
    let slug = a.dataset.slug;
    if (!slug) {
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname.startsWith("/api/") || /\.\w{2,5}$/.test(url.pathname) || url.hash && url.pathname === location.pathname) return;
      slug = slugify(decodeURIComponent(url.pathname.slice(1))) || SITE.home;
    }
    e.preventDefault();
    openNote(slug, { fromIndex, title: a.dataset.title });
    return;
  }
  const card = e.target.closest(".backlink");
  if (card) openNote(card.dataset.slug, { fromIndex });
});

addEventListener("popstate", () => {
  state.stack = parseLocation();
  renderStack();
  requestAnimationFrame(() => scrollToPane(state.stack.length - 1));
});

addEventListener("beforeunload", (e) => {
  if (panes.some((p) => p.editing?.dirty)) e.preventDefault();
});

// ---------- Hover previews ----------

let hoverTimer;
document.addEventListener("mouseover", (e) => {
  const a = e.target.closest?.("a.wikilink, .backlink");
  if (!a || a.closest(".popover") || a.closest(".modal")) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => showPopover(a), 350);
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest?.("a.wikilink, .backlink")) {
    clearTimeout(hoverTimer);
    hidePopover();
  }
});

function showPopover(a) {
  if (isMobile() || !document.contains(a)) return;
  const slug = a.dataset.slug;
  if (a.classList.contains("backlink") && state.stack.includes(slug)) return;
  const note = state.notes.get(slug);
  $popover.innerHTML = `<h3>${esc(titleFor(slug))}</h3>` +
    (note ? `<div class="note-body">${renderMarkdown(note.body)}</div>` : `<p class="missing-note">Not written yet.</p>`);
  $popover.hidden = false;
  const r = a.getBoundingClientRect();
  const pw = $popover.offsetWidth, ph = $popover.offsetHeight;
  let top = r.bottom + 8;
  if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 8);
  const left = Math.min(Math.max(8, r.left), innerWidth - pw - 8);
  $popover.style.top = top + "px";
  $popover.style.left = left + "px";
}
function hidePopover() {
  clearTimeout(hoverTimer);
  $popover.hidden = true;
}

// ---------- Editing ----------

const draftKey = (slug) => "notes.draft:" + slug;

function startEdit(p) {
  if (!loggedIn()) return openLogin();
  const note = state.notes.get(p.slug);
  const draft = storage.getJSON(draftKey(p.slug));
  const useDraft = draft && draft.body !== (note?.body ?? "");
  p.editing = { base: note ? note.updated : null, dirty: Boolean(useDraft) };

  const titleInput = note
    ? h("h1", {}, note.title)
    : h("input", { class: "title-input", type: "text", value: (useDraft && draft.title) || titleFor(p.slug), placeholder: "Title", "aria-label": "Title" });
  const textarea = h("textarea", { spellcheck: "true", placeholder: "Write in Markdown. Type [[ to link to another note.", "aria-label": "Note text" });
  textarea.value = useDraft ? draft.body : note?.body ?? "";
  const preview = h("div", { class: "editor-preview note-body", hidden: true });
  const previewBtn = h("button", { onclick: togglePreview }, "Preview");
  const saveBtn = h("button", { class: "primary", onclick: save }, "Save");
  const notice = useDraft
    ? h("div", { class: "editor-notice" },
        `Restored your unsaved draft from ${fmtDate(draft.at, true)}.`,
        h("button", { onclick: () => { textarea.value = note?.body ?? ""; storage.del(draftKey(p.slug)); p.editing.dirty = false; notice.remove(); } }, "Discard draft"))
    : null;
  const ac = h("div", { class: "autocomplete", hidden: true });
  const editor = h("div", { class: "editor", style: "position:relative" },
    titleInput, notice, textarea, preview,
    h("div", { class: "editor-bar" },
      saveBtn, h("button", { onclick: cancel }, "Cancel"), previewBtn,
      h("span", { class: "hint" }, "⌘/Ctrl+S save · Esc cancel · [[ link")),
    ac);

  p.scroll.replaceChildren(editor);
  textarea.focus();
  if (!useDraft) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  if (!note) titleInput.select?.();

  let draftTimer;
  const onChange = () => {
    p.editing.dirty = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => storage.setJSON(draftKey(p.slug), {
      body: textarea.value, title: note ? note.title : titleInput.value, at: new Date().toISOString(),
    }), 300);
  };
  textarea.addEventListener("input", () => { onChange(); updateAutocomplete(); });
  if (!note) titleInput.addEventListener("input", () => { onChange(); p.spine.textContent = titleInput.value; });
  textarea.addEventListener("blur", () => setTimeout(() => (ac.hidden = true), 150));

  editor.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    } else if (!ac.hidden && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) {
      e.preventDefault();
      const items = [...ac.children];
      let sel = items.findIndex((d) => d.classList.contains("sel"));
      if (e.key === "Escape") ac.hidden = true;
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((d, i) => d.classList.toggle("sel", i === sel));
      } else insertLink(items[Math.max(0, sel)].dataset.title);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });

  function togglePreview() {
    const on = preview.hidden;
    preview.hidden = !on;
    textarea.hidden = on;
    previewBtn.textContent = on ? "Write" : "Preview";
    if (on) preview.innerHTML = renderMarkdown(textarea.value);
    else textarea.focus();
  }

  function cancel() {
    if (p.editing.dirty && !confirm("Discard your changes to this note?")) return;
    storage.del(draftKey(p.slug));
    p.editing = null;
    if (!note && panes.length > 1 && !state.backlinks.has(p.slug)) return closePane(panes.indexOf(p));
    renderPane(p);
    updateActiveLinks();
  }

  async function save(_e, { force = false } = {}) {
    const title = note ? note.title : titleInput.value.trim();
    if (!title) return toast("Give the note a title first.", true);
    const slug = slugify(title);
    if (!note && slug !== p.slug && state.notes.has(slug)) {
      return toast(`A note called "${state.notes.get(slug).title}" already exists.`, true);
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const payload = { title, body: textarea.value };
      if (!force) payload.baseUpdated = p.editing.base;
      const { note: saved } = await api(notePath(slug), { method: "PUT", body: payload });
      storage.del(draftKey(p.slug));
      state.notes.set(saved.slug, saved);
      p.editing = null;
      if (saved.slug !== p.slug) {
        const old = p.slug;
        p.slug = saved.slug;
        state.stack = state.stack.map((s) => (s === old ? saved.slug : s));
        history.replaceState({}, "", stackURL(state.stack));
      }
      rebuildIndex();
      rerenderAll();
      toast("Saved");
    } catch (err) {
      if (err.status === 409 && err.data?.current) return conflict(err.data.current);
      toast(err.message, true);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  }

  function conflict(current) {
    const m = modal({
      title: "This note changed while you were editing",
      body: h("div", {},
        h("p", {}, `Someone saved "${current.title}" at ${fmtDate(current.updated, true)}, after you started editing. What should happen?`),
        h("p", { class: "muted" }, "Your text is also kept as a draft in this browser.")),
      actions: [
        { label: "Keep editing", onClick: () => m.close() },
        { label: "Use their version", onClick: () => {
            navigator.clipboard?.writeText(textarea.value).catch(() => {});
            textarea.value = current.body;
            p.editing.base = current.updated;
            state.notes.set(current.slug, current);
            m.close();
            toast("Loaded their version. Your text was copied to the clipboard.");
          } },
        { label: "Overwrite with mine", primary: true, onClick: () => { m.close(); save(null, { force: true }); } },
      ],
    });
  }

  // [[ autocomplete
  function linkQuery() {
    const before = textarea.value.slice(0, textarea.selectionStart);
    const m = /\[\[([^\]\[\n|]*)$/.exec(before);
    return m ? { query: m[1], start: before.length - m[1].length } : null;
  }
  function updateAutocomplete() {
    const q = linkQuery();
    if (!q) return (ac.hidden = true);
    const needle = q.query.toLowerCase();
    const matches = [...state.notes.values()]
      .filter((n) => n.title.toLowerCase().includes(needle))
      .sort((a, b) => (b.title.toLowerCase().startsWith(needle) - a.title.toLowerCase().startsWith(needle)) || a.title.localeCompare(b.title))
      .slice(0, 8);
    if (!matches.length) return (ac.hidden = true);
    ac.replaceChildren(...matches.map((n, i) =>
      h("div", { class: i === 0 ? "sel" : "", "data-title": n.title, onmousedown: (e) => { e.preventDefault(); insertLink(n.title); } }, n.title)));
    const c = caretCoords(textarea);
    ac.style.top = textarea.offsetTop + c.top + c.lineHeight + 4 + "px";
    ac.style.left = Math.min(textarea.offsetLeft + c.left, editor.clientWidth - 260) + "px";
    ac.hidden = false;
  }
  function insertLink(title) {
    const q = linkQuery();
    if (!q) return;
    const end = textarea.selectionStart;
    const closing = textarea.value.slice(end, end + 2) === "]]" ? "" : "]]";
    textarea.setRangeText(title + closing, q.start, end, "end");
    if (!closing) textarea.selectionStart = textarea.selectionEnd = q.start + title.length + 2;
    ac.hidden = true;
    onChange();
  }
}

function caretCoords(ta) {
  const cs = getComputedStyle(ta);
  const div = document.createElement("div");
  for (const prop of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderLeftWidth", "borderRightWidth", "boxSizing", "tabSize"]) {
    div.style[prop] = cs[prop];
  }
  Object.assign(div.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "break-word", width: ta.offsetWidth + "px", top: "0", left: "-9999px" });
  div.textContent = ta.value.slice(0, ta.selectionStart);
  const span = document.createElement("span");
  span.textContent = "​";
  div.append(span);
  document.body.append(div);
  const out = { top: span.offsetTop - ta.scrollTop, left: span.offsetLeft, lineHeight: parseFloat(cs.lineHeight) || 24 };
  div.remove();
  return out;
}

// ---------- Modals ----------

function modal({ title, body, actions = [], className = "" }) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const box = h("div", { class: "modal " + className, role: "dialog", "aria-modal": "true", "aria-label": title },
    h("header", {}, title, h("button", { class: "close", "aria-label": "Close", onclick: () => close() }, "×")),
    h("div", { class: "modal-body" }, body),
    actions.length
      ? h("div", { class: "modal-actions" },
          actions.map((a) => h("button", { class: [a.primary && "primary", a.danger && "danger"].filter(Boolean).join(" "), onclick: a.onClick }, a.label)))
      : null);
  const backdrop = h("div", { class: "modal-backdrop", onmousedown: (e) => e.target === backdrop && close() }, box);
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey, true);
  box.querySelector("input")?.focus();
  return { close, box };
}

function plain(md) {
  return md
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function highlight(text, terms) {
  let out = esc(text);
  for (const t of terms) {
    if (!t) continue;
    out = out.replace(new RegExp("(" + esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi"), "<mark>$1</mark>");
  }
  return out;
}

function searchNotes(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = [...state.notes.values()];
  if (!terms.length) return all.sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 12).map((n) => ({ note: n, snippet: "" }));
  const ql = q.toLowerCase().trim();
  const results = [];
  for (const n of all) {
    const t = n.title.toLowerCase();
    const text = plain(n.body);
    const b = text.toLowerCase();
    if (!terms.every((term) => t.includes(term) || b.includes(term))) continue;
    let score = t === ql ? 1000 : t.startsWith(ql) ? 500 : t.includes(ql) ? 200 : 0;
    for (const term of terms) {
      if (t.includes(term)) score += 50;
      score += Math.min(10, b.split(term).length - 1);
    }
    const first = Math.min(...terms.map((term) => b.indexOf(term)).filter((i) => i >= 0), Infinity);
    let snippet = "";
    if (first !== Infinity) {
      const s = Math.max(0, first - 60);
      snippet = (s > 0 ? "…" : "") + text.slice(s, s + 180) + (s + 180 < text.length ? "…" : "");
    } else snippet = text.slice(0, 160);
    results.push({ note: n, snippet, score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 40);
}

function openSearch() {
  const input = h("input", { type: "search", placeholder: "Search notes…", "aria-label": "Search notes", autocomplete: "off" });
  const list = h("ul", { class: "result-list" });
  let sel = 0, results = [];
  const go = (slug) => { m.close(); openNote(slug); };
  const draw = () => {
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    results = searchNotes(input.value);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    const items = results.map((r, i) =>
      h("li", { class: i === sel ? "sel" : "", onclick: () => go(r.note.slug) },
        h("div", { class: "r-title", html: highlight(r.note.title, terms) }),
        r.snippet ? h("div", { class: "r-snippet", html: highlight(r.snippet, terms) }) : null));
    if (!terms.length && results.length) items.unshift(h("li", { class: "empty section-label" }, "Recently edited"));
    if (input.value.trim() && loggedIn() && !state.notes.has(slugify(input.value))) {
      items.push(h("li", { onclick: () => { m.close(); state.pendingTitles.set(slugify(input.value), input.value.trim()); openNote(slugify(input.value), { edit: true }); } },
        h("div", { class: "r-title" }, `+ Create “${input.value.trim()}”`)));
    }
    if (!items.length) items.push(h("li", { class: "empty" }, "No matching notes."));
    list.replaceChildren(...items);
    list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => { sel = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, results.length - 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === "Enter" && results[sel]) go(results[sel].note.slug);
  });
  const m = modal({ title: "Search", className: "search-modal", body: h("div", {}, h("div", { class: "search-input" }, input), list) });
  draw();
}

function openIndex() {
  const input = h("input", { type: "search", placeholder: "Filter by title…", "aria-label": "Filter notes" });
  const list = h("ul", { class: "result-list" });
  const deleted = h("div");
  const draw = () => {
    const f = input.value.toLowerCase();
    const notes = [...state.notes.values()].filter((n) => n.title.toLowerCase().includes(f)).sort((a, b) => b.updated.localeCompare(a.updated));
    list.replaceChildren(
      ...(notes.length
        ? notes.map((n) => h("li", { onclick: () => { m.close(); openNote(n.slug); } },
            h("span", { class: "r-date" }, fmtDate(n.updated)), h("span", { class: "r-title" }, n.title)))
        : [h("li", { class: "empty" }, "No notes match.")])
    );
  };
  input.addEventListener("input", draw);
  draw();

  api("/deleted").then(({ deleted: items }) => {
    if (!items.length) return;
    deleted.replaceChildren(
      h("div", { class: "section-label" }, "Recently deleted"),
      h("ul", { class: "result-list" }, items.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).map((d) =>
        h("li", { onclick: () => previewRevision(d.slug, d.id, { deleted: true, onDone: () => m.close() }) },
          h("span", { class: "r-date" }, fmtDate(d.savedAt)),
          h("span", { class: "r-title" }, d.slug.replace(/_/g, " "))))));
  }).catch(() => {});

  const actions = [{ label: "Export all (JSON)", onClick: exportNotes }];
  if (loggedIn()) actions.push({ label: "Import…", onClick: () => { m.close(); importNotes(); } });
  const m = modal({
    title: `All notes (${state.notes.size})`,
    body: h("div", {}, input, h("div", { style: "margin: 8px -18px 0" }, list, deleted)),
    actions,
  });
}

function exportNotes() {
  const data = {
    exportedAt: new Date().toISOString(),
    notes: [...state.notes.values()].map(({ title, body, created, updated }) => ({ title, body, created, updated })),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = h("a", { href: url, download: `notes-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importNotes() {
  const file = h("input", { type: "file", accept: ".json,.md,.markdown,.txt", multiple: true });
  const status = h("p", { class: "muted" }, "Choose a JSON export from this site, or one or more Markdown files (the file name becomes the title). Notes with the same title are overwritten; the old version stays in History.");
  const m = modal({
    title: "Import notes",
    body: h("div", {}, status, file),
    actions: [{ label: "Import", primary: true, onClick: run }],
  });
  async function run() {
    const notes = [];
    try {
      for (const f of file.files) {
        const text = await f.text();
        if (f.name.endsWith(".json")) {
          const data = JSON.parse(text);
          for (const n of Array.isArray(data) ? data : data.notes || []) {
            if (typeof n.title === "string" && typeof n.body === "string") notes.push({ title: n.title, body: n.body, created: n.created });
          }
        } else {
          notes.push({ title: f.name.replace(/\.(md|markdown|txt)$/i, ""), body: text });
        }
      }
    } catch (err) {
      return (status.textContent = "Couldn't read that file: " + err.message);
    }
    if (!notes.length) return (status.textContent = "No notes found in those files.");
    // Netlify functions accept up to ~6 MB per request, so send in batches.
    let created = 0, updated = 0, batch = [], size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const r = await api("/import", { method: "POST", body: { notes: batch } });
      created += r.created;
      updated += r.updated;
      batch = [];
      size = 0;
    };
    try {
      for (const n of notes) {
        status.textContent = `Importing… ${created + updated} done`;
        batch.push(n);
        size += n.body.length + n.title.length;
        if (batch.length >= 100 || size > 2_000_000) await flush();
      }
      await flush();
    } catch (err) {
      return (status.textContent = "Import failed: " + err.message);
    }
    await fetchNotes();
    rerenderAll();
    m.close();
    toast(`Imported: ${created} new, ${updated} updated.`);
  }
}

async function openHistory(slug) {
  const note = state.notes.get(slug);
  const list = h("ul", { class: "result-list" }, h("li", { class: "empty" }, "Loading…"));
  const preview = h("div", { class: "history-preview" }, h("p", { class: "muted" }, "Pick a version on the left to read it."));
  const m = modal({ title: `History: ${note.title}`, className: "wide", body: h("div", { class: "history-layout" }, list, preview) });
  try {
    const { revisions } = await api(notePath(slug, "/history"));
    const items = [
      h("li", { class: "sel", onclick: (e) => { select(e); preview.replaceChildren(h("p", { class: "muted" }, "Current version"), h("div", { class: "note-body", html: renderMarkdown(note.body) })); } },
        h("div", { class: "r-title" }, "Current"), h("div", { class: "r-snippet" }, fmtDate(note.updated, true))),
      ...revisions.map((r) => h("li", { onclick: (e) => { select(e); showRevision(r.id); } }, h("div", { class: "r-snippet" }, fmtDate(r.savedAt, true)))),
    ];
    if (!revisions.length) items.push(h("li", { class: "empty" }, "No earlier versions yet."));
    list.replaceChildren(...items);
  } catch (err) {
    list.replaceChildren(h("li", { class: "empty" }, err.message));
  }
  function select(e) {
    list.querySelectorAll("li").forEach((li) => li.classList.toggle("sel", li === e.currentTarget));
  }
  async function showRevision(id) {
    preview.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    try {
      const { revision } = await api(notePath(slug, "/history/" + id));
      preview.replaceChildren(
        h("p", { class: "muted" }, `Saved ${fmtDate(revision.updated, true)}` + (revision.reason && revision.reason !== "edit" ? ` · replaced by ${revision.reason}` : "")),
        loggedIn() ? h("p", {}, h("button", { class: "btn primary", onclick: () => restore(revision) }, "Restore this version")) : null,
        h("div", { class: "note-body", html: renderMarkdown(revision.body) }));
    } catch (err) {
      preview.replaceChildren(h("p", { class: "error" }, err.message));
    }
  }
  async function restore(revision) {
    const current = state.notes.get(slug);
    const pane = panes.find((p) => p.slug === slug);
    if (pane?.editing) return toast("Finish or cancel your edit before restoring.", true);
    try {
      const { note: saved } = await api(notePath(slug), { method: "PUT", body: { title: current.title, body: revision.body, baseUpdated: current.updated } });
      state.notes.set(slug, saved);
      rebuildIndex();
      rerenderAll();
      m.close();
      toast("Restored. The version you replaced is in History.");
    } catch (err) {
      toast(err.message, true);
    }
  }
}

async function previewRevision(slug, id, { onDone }) {
  try {
    const { revision } = await api(notePath(slug, "/history/" + id));
    const m = modal({
      title: `Deleted: ${revision.title}`,
      className: "wide",
      body: h("div", { class: "note-body", html: renderMarkdown(revision.body) }),
      actions: loggedIn()
        ? [{ label: "Delete forever", danger: true, onClick: async () => {
            if (!confirm(`Permanently delete “${revision.title}” and all its history? This can't be undone.`)) return;
            try {
              await api("/deleted/" + encodeURIComponent(slug), { method: "DELETE" });
              m.close();
              onDone?.();
              toast("Permanently deleted.");
            } catch (err) { toast(err.message, true); }
          } },
          { label: "Restore note", primary: true, onClick: async () => {
            try {
              const { note } = await api(notePath(slug), { method: "PUT", body: { title: revision.title, body: revision.body, baseUpdated: null } });
              state.notes.set(note.slug, note);
              rebuildIndex();
              rerenderAll();
              m.close();
              onDone?.();
              openNote(note.slug);
              toast("Note restored.");
            } catch (err) { toast(err.message, true); }
          } }]
        : [],
    });
  } catch (err) {
    toast(err.message, true);
  }
}

function openRename(slug) {
  const note = state.notes.get(slug);
  const count = (state.backlinks.get(slug) || []).length;
  const input = h("input", { type: "text", value: note.title, "aria-label": "New title" });
  const update = h("input", { type: "checkbox", checked: true });
  const error = h("div", { class: "error" });
  const m = modal({
    title: "Rename note",
    body: h("div", {}, input,
      count ? h("label", { class: "check" }, update, `Update links in ${count} note${count === 1 ? "" : "s"} that link here`) : null,
      error),
    actions: [{ label: "Cancel", onClick: () => m.close() }, { label: "Rename", primary: true, onClick: run }],
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && run());
  async function run() {
    const title = input.value.trim();
    if (!title || title === note.title) return m.close();
    try {
      const r = await api(notePath(slug, "/rename"), { method: "POST", body: { title, updateLinks: update.checked } });
      if (r.removed) state.notes.delete(r.removed);
      for (const n of r.changed) state.notes.set(n.slug, n);
      const newSlug = r.note.slug;
      panes.forEach((p) => p.slug === slug && (p.slug = newSlug));
      state.stack = state.stack.map((s) => (s === slug ? newSlug : s));
      history.replaceState({}, "", stackURL(state.stack));
      rebuildIndex();
      rerenderAll();
      m.close();
      toast("Renamed.");
    } catch (err) {
      error.textContent = err.message;
    }
  }
}

function openDelete(slug) {
  const note = state.notes.get(slug);
  const m = modal({
    title: "Delete note",
    body: h("p", {}, `Delete “${note.title}”? You can bring it back later from Index → Recently deleted.`),
    actions: [
      { label: "Cancel", onClick: () => m.close() },
      { label: "Delete", danger: true, onClick: async () => {
          try {
            await api(notePath(slug), { method: "DELETE" });
            state.notes.delete(slug);
            storage.del(draftKey(slug));
            m.close();
            rebuildIndex();
            const i = state.stack.indexOf(slug);
            if (state.stack.length > 1) {
              panes.splice(i, 1)[0].el.remove();
              navigate(state.stack.filter((s) => s !== slug), { replace: true, focus: Math.max(0, i - 1) });
            }
            rerenderAll();
            toast("Deleted.");
          } catch (err) { toast(err.message, true); }
        } },
    ],
  });
}

function openNewNote() {
  if (!loggedIn()) return openLogin();
  const input = h("input", { type: "text", placeholder: "Title, e.g. “Spaced repetition makes memory a choice”", "aria-label": "Title" });
  const m = modal({
    title: "New note",
    body: input,
    actions: [{ label: "Cancel", onClick: () => m.close() }, { label: "Create", primary: true, onClick: go }],
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  function go() {
    const title = input.value.trim();
    const slug = slugify(title);
    if (!slug) return;
    m.close();
    state.pendingTitles.set(slug, title);
    openNote(slug, { edit: !state.notes.has(slug) });
  }
}

function openLogin() {
  if (!state.editable) {
    const m = modal({
      title: "Editing is turned off",
      body: h("div", {},
        h("p", {}, "This site doesn't have an edit password yet."),
        h("p", { class: "muted" }, "In Netlify, go to Site configuration → Environment variables, add EDIT_PASSWORD with a long password, then redeploy (Deploys → Trigger deploy).")),
      actions: [{ label: "OK", primary: true, onClick: () => m.close() }],
    });
    return;
  }
  const input = h("input", { type: "password", placeholder: "Password", "aria-label": "Password", autocomplete: "current-password" });
  const error = h("div", { class: "error" });
  const m = modal({
    title: "Log in to edit",
    body: h("form", { onsubmit: (e) => { e.preventDefault(); go(); } }, input, error),
    actions: [{ label: "Log in", primary: true, onClick: go }],
  });
  async function go() {
    try {
      await api("/login", { method: "POST", token: input.value });
      state.token = input.value;
      storage.set("notes.token", input.value);
      m.close();
      updateAuthUI();
      rerenderAll();
      toast("Logged in. You can edit now.");
    } catch (err) {
      error.textContent = err.status === 401 ? "That password isn't right." : err.message;
    }
  }
}

function logout(message) {
  state.token = null;
  storage.del("notes.token");
  updateAuthUI();
  rerenderAll();
  if (message) toast(message, true);
}

function updateAuthUI() {
  document.body.classList.toggle("can-edit", loggedIn());
  $(".login-btn").textContent = loggedIn() ? "Log out" : "Log in";
}

function openRandom() {
  const options = [...state.notes.keys()].filter((s) => !state.stack.includes(s));
  if (!options.length) return toast("Every note is already open.");
  openNote(options[Math.floor(Math.random() * options.length)]);
}

// ---------- Header & keyboard ----------

document.querySelector(".site-header").addEventListener("click", (e) => {
  const home = e.target.closest("[data-home]");
  if (home) {
    e.preventDefault();
    if (confirmDiscard(0)) navigate([SITE.home]);
    return;
  }
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "search") openSearch();
  else if (action === "index") openIndex();
  else if (action === "random") openRandom();
  else if (action === "new") openNewNote();
  else if (action === "login") loggedIn() ? logout() : openLogin();
});

document.addEventListener("keydown", (e) => {
  if ($(".modal-backdrop")) return;
  const typing = e.target.closest?.("input, textarea, [contenteditable]");
  if (!typing && (e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k"))) {
    e.preventDefault();
    openSearch();
  }
});

// Pick up edits made on other devices when coming back to the tab.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || Date.now() - state.lastFetch < 30_000) return;
  try {
    await fetchNotes();
    rerenderAll();
  } catch {}
});

// ---------- Start ----------

(async function init() {
  $(".site-title").textContent = SITE.title;
  try {
    await fetchNotes();
  } catch (err) {
    $stack.innerHTML = `<div class="fatal">Couldn't load notes: ${esc(err.message)}.<br>If you're running this locally, use <code>npm run dev</code>.</div>`;
    return;
  }
  if (state.token && !state.editable) logout();
  updateAuthUI();
  state.stack = parseLocation();
  renderStack();
  requestAnimationFrame(() => scrollToPane(state.stack.length - 1, "instant"));
})();
