# Stacked Notes

An editable, self-hosted take on the "working notes" style of
[notes.andymatuschak.org](https://notes.andymatuschak.org): linked notes that
open side by side in sliding panes. Unlike the original, which is read-only,
you can write, edit and search your notes in the browser, and every change is
saved on Netlify.

**What it does**

- **Stacked panes.** Clicking a link opens the note to the right. Older notes
  slide under newer ones and leave a title spine you can click to bring them
  back. The whole stack is kept in the URL
  (`/Note?stackedNotes=Other_note`), so you can share it.
- **`[[Wiki links]]`**, including `[[Title|label]]`. A link to a note that
  doesn't exist yet shows dashed; click it to write that note.
- **Backlinks.** Each note ends with "Links to this note", showing the context
  around each link.
- **Hover previews** of any linked note.
- **Editing in the browser.** Markdown with preview, `[[` autocomplete,
  Ctrl/⌘+S to save, and unsaved drafts that survive closing the tab.
- **Conflict detection.** If a note was saved from another device while you
  were editing it, you're asked before anything is overwritten.
- **Revision history.** The last 50 versions of each note, each one
  restorable. Deleted notes can be restored too, or deleted for good.
- **Rename** with automatic updating of links in other notes.
- **Search** (`/` or Ctrl/⌘+K), an **Index** of all notes sorted by last
  edit, and a **Random** note button.
- **Export** to JSON, and **import** from JSON or from Markdown files (for
  example an Obsidian vault).
- **Mobile layout** that shows one note at a time with a breadcrumb trail,
  plus dark mode.

Anyone can read the site. Changing anything requires the password you set.

---

## Put it live on Netlify (about 5 minutes)

You need a free [GitHub](https://github.com) account and a free
[Netlify](https://netlify.com) account.

1. **Put this folder on GitHub.** Create a new repository, then from this
   folder run:
   ```bash
   git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
   git push -u origin main
   ```
   You can also upload the files with GitHub's "uploading an existing file"
   page.
2. **Create the site.** In Netlify, choose **Add new site → Import an existing
   project → GitHub**, then pick the repository. Leave every build setting as
   it is; `netlify.toml` already sets them. Click **Deploy**.
3. **Set your edit password.** Go to **Site configuration → Environment
   variables → Add a variable**. Set the key to `EDIT_PASSWORD` and the value
   to a long password only you know.
4. **Redeploy** so the password takes effect: **Deploys → Trigger deploy →
   Deploy site**.
5. Open your site, click **Log in**, and enter the password. You can now edit.

Netlify Blobs stores the notes. It's built into Netlify, so there's no
database to set up. Your notes persist across deploys.

**Using the command line instead:**
```bash
npm install
npx netlify-cli login
npx netlify-cli init                       # create and link a new site
npx netlify-cli env:set EDIT_PASSWORD 'your-long-password'
npx netlify-cli deploy --prod
```

> Netlify's drag-and-drop deploy (Netlify Drop) **won't work**: it only hosts
> static files, and this site needs its API function.

## Make it yours

- **Site name and home note:** edit `public/config.js`.
- **Look:** edit `public/styles.css`. The colours are variables at the top.
- **Starter notes:** these are written into an empty site the first time it
  loads (`netlify/lib/seed.mjs`). After that, edit or delete them in the
  browser like any other note.
- **Bring existing notes:** log in, open **Index → Import…**, and choose
  Markdown files. Each file name becomes the note's title.

## Run it on your computer

```bash
npm install
npm run dev          # http://localhost:8888, password: dev
npm test             # in a second terminal: checks every API route
```

The local server runs the same API code against a local copy of Netlify Blobs
stored in `.dev-data/`, so you don't need a Netlify account to try it.
`netlify dev` from the Netlify CLI also works.

## How it's built

```
public/                    the website (plain HTML/CSS/JS, no build step)
  index.html  app.js       single-page app: panes, routing, editor, search…
  styles.css  config.js
  slug.js                  title → URL rules (copy of netlify/lib/slug.mjs)
  vendor/                  marked (Markdown) and DOMPurify (sanitising)
netlify/functions/api.mjs  the API, served at /api/*
netlify/lib/               shared helpers and the starter notes
netlify.toml               build settings; sends every page URL to index.html
scripts/dev.mjs            local server
scripts/smoke-test.mjs     API tests
```

**API** (reads are public; writes need `Authorization: Bearer <EDIT_PASSWORD>`):

| Method & path | Does |
| --- | --- |
| `GET /api/notes` | all notes, plus whether editing is turned on |
| `GET /api/notes/:slug` | one note |
| `PUT /api/notes/:slug` | create or update `{title, body, baseUpdated}`; returns 409 if `baseUpdated` is out of date |
| `DELETE /api/notes/:slug` | delete (kept in history) |
| `POST /api/notes/:slug/rename` | `{title, updateLinks}` |
| `GET /api/notes/:slug/history[/:id]` | list past versions, or read one |
| `GET /api/deleted` / `DELETE /api/deleted/:slug` | list deleted notes / delete one for good |
| `POST /api/import` | `{notes: [{title, body}]}` |
| `POST /api/login` | check the password |

**Limits:** The site loads every note at once, which makes search and
backlinks instant. That works comfortably up to a few thousand typical notes.
Netlify functions return at most about 6 MB per response, so a much larger
collection would need paging.

**Security:** There's one shared password, and it's stored in the browser
after you log in. Use a long, unique password, and log out on shared
computers. Note content is sanitised before it's displayed, so even someone
with the password can't inject scripts into the page.
