// Notes written into an empty site on first load. Edit or delete them freely.
export const SEED_NOTES = [
  {
    title: "About these notes",
    body: `Hi! These are my working notes. I write them to think, not to publish finished essays, so expect rough edges.

The notes are connected by links. Click one and it opens in a new pane to the right, so you can follow a trail of thought while keeping where you came from in view. See [[Stacked notes]].

Each note ends with a list of the notes that link to it. Those backlinks are often more useful than the links going out. See [[Wiki links and backlinks]].

If you own this site, you can change anything here: [[How to edit notes]].

A few places to start:
- [[Notes should be atomic]]
- [[Searching and recall]]
- [[Revision history]]
`,
  },
  {
    title: "Stacked notes",
    body: `Opening a link adds a pane to the right of the current one instead of replacing the page. When the stack gets wider than the screen, older panes slide under newer ones and shrink to a thin spine showing their title. Click a spine to bring that note back.

The whole stack lives in the address bar (\`/First_note?stackedNotes=Second_note&stackedNotes=Third_note\`), so you can copy the URL and share exactly the trail you're looking at.

Clicking a link in an older pane closes everything to its right before opening the new note, so a stack always reads as one path.

On a phone, panes stack vertically instead.

Related: [[Wiki links and backlinks]]
`,
  },
  {
    title: "Wiki links and backlinks",
    body: `Write \`[[Note title]]\` to link to another note, or \`[[Note title|some other words]]\` to show different link text.

If the note doesn't exist yet, the link appears dashed. Clicking it opens a blank note with that title, ready to write. Creating the link first and the note second is a nice way to leave yourself a thread to pull on later.

Hover over any link to preview the note without opening it.

At the bottom of every note, **Links to this note** lists every note that mentions it, with the surrounding sentence for context.

Related: [[Notes should be atomic]], [[Stacked notes]]
`,
  },
  {
    title: "Notes should be atomic",
    body: `A note works best when it's about one thing. Small notes are easier to link to precisely, easier to reuse in new contexts, and easier to revise without breaking something elsewhere.

A good test: can you give the note a title that's a complete claim? "Notes should be atomic" is better than "Notes" because the title alone tells you what the note argues.

This pairs with [[Wiki links and backlinks]]: when notes are small, links between them carry most of the structure.
`,
  },
  {
    title: "How to edit notes",
    body: `1. Click **Log in** in the header and enter the site password (the \`EDIT_PASSWORD\` you set in Netlify).
2. Every pane now has **Edit**, **History**, **Rename** and **Delete** buttons.
3. Edit the Markdown, then press **Save** or **Ctrl/⌘ + S**. **Esc** cancels.
4. Make a new note with **+ New note** in the header, or by clicking a dashed link to a note that doesn't exist yet.

While you type, your draft is kept in this browser. If the tab closes before you save, the draft comes back next time you edit that note.

If someone else saved the same note while you were editing, you'll be told before anything is overwritten.

Markdown supported: headings, **bold**, *italics*, lists, > quotes, \`code\`, tables, images, and ordinary [web links](https://www.netlify.com).

See also: [[Revision history]], [[Searching and recall]]
`,
  },
  {
    title: "Searching and recall",
    body: `Press **/** or **Ctrl/⌘ + K** anywhere to search. It matches titles first, then note text, and shows a snippet of each match. Use the arrow keys and Enter to open a result.

The **Index** button in the header lists every note, most recently edited first, which is handy for picking up where you left off.

**Random** opens a note at random. It's a good way to rediscover something you'd forgotten you wrote.

Related: [[Revision history]]
`,
  },
  {
    title: "Revision history",
    body: `Every save keeps the previous version (up to 50 per note). Open **History** on a note to read any earlier version and restore it.

Deleted notes aren't really gone: the **Index** has a "Recently deleted" section where you can bring them back.

For a full backup, use **Export** in the Index to download every note as JSON. **Import** loads a file like that back in, keeping history for anything it overwrites.

Back to [[About these notes]]
`,
  },
];
