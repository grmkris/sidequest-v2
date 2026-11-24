# crit: this project's review pages

Working pages for the people on this project to read and comment on: research, spikes, plans, mockups and reviews.
`crit.config.ts` says where it runs and who gets in. Everything is on one address: the team opens pages signed in at
`/<slug>/`, a page someone opened to everyone is also at `/p/<slug>/`, and a share link opens one page for whoever
has it. It is a stack of its own (`alchemy.run.ts`) beside the product's
and is never part of a product release.

Run every command as `bun run --cwd <this folder> <command>`.

## Publish a page

1. Copy `pages/_template/` to `pages/<slug>/` and set `<title>`, `<meta name="description">` and
   `<meta name="date">`; the index lists a page by these three. A page is plain HTML with no framework.
2. Put images and video beside `index.html` and reference them relatively (`shots/a.webp`, `media/demo.mp4`), so the
   page also works in public and by a share link. Keep a file under 25 MiB; prefer WebP for images.
3. `publish <slug>`. It is live for the team when the command returns: no build, no deploy, no commit. Publish again
   after every edit; only changed files are sent. A page's name cannot be `p`, `s`, `api`, `mcp`, `lib`, `_crit` or
   `cdn-cgi`.

- **Markdown:** `publish <slug> --from ../../docs/plan.md` publishes a Markdown file as a page (the path is relative
  to this folder, or absolute), and a `.md` file inside a page folder gets a rendered page beside it. Links into the repository become GitHub links at the commit; pictures
  are published with the page. The source file stays the truth: change it and publish again, never edit the output.
- **Diagrams:** write Mermaid in `<pre class="mermaid">` (in Markdown, a `mermaid` fence). pele draws it; there is no
  mermaid.js.
- **Look:** use `/lib/base.css` and its colour variables (`--ink`, `--card`, `--line`, `--muted`, `--accent`), so a
  page reads in dark mode too.
- **Comments:** keep `<script src="/lib/comments.js" defer></script>` on the page. Give a block a
  `data-review-id="…"` when its comments should stay on it through edits to its text.
- `pages` lists what is live. `publish --remove <slug>` takes a page down. Pages folders are not committed unless
  the page should stay in the repository.

## Show a page to someone outside the team

A page is the team's until someone opens it. There are two ways, and both make it public:

- **A share link:** `share <slug>` prints a link that opens that one page without signing in, and the link's id.
  `--days 7` makes a link that ends, `--list` shows the ids of the links that work, `--revoke <id>` stops one link
  and `--revoke` alone stops every link of the page. The link is shown once.
- **A public page:** `visibility <slug> public` (or `publish <slug> --public`) opens the page to anyone at
  `/p/<slug>/`, when the site allows public pages. `visibility <slug> team` closes it. A publish that says neither
  leaves the page as it is. A signed-in member can do the same with the buttons on the index.

**Both are public.** Before either, make sure the page and every file in it hold no private or personal data, no
customer data and nothing only the team may see, and that a person asked for it. When unsure, ask first.

## Read and answer comments

- `comments` prints the open threads of every page as Markdown; `comments <slug>` one page's; `--all` adds resolved
  ones.
- Act on a thread, publish the page again, then `comments reply <thread> "what you did" --as <your name>`.
- **You answer; people resolve.** There is no command to resolve a thread, and a question you cannot answer stays
  open with your reply saying what is missing.

## Rules

- **Publish findings, not progress.** Never keep a status board, a checklist or a "plan v7" page here. The project's
  own status document is the only one.
- **Take a page down when its question is settled** (`publish --remove`), or let it expire. `keep <slug>` exempts a
  page that should stay when the site has an expiry.
- **Never publish secrets.** The publish refuses secret-looking text and files such as `.env`. `--allow-secrets`
  exists for a false alarm, only after a person said so; it is recorded with the version.
- **Publish only what this project's own agents made.** Every page on the address can reach every other, so a page
  with someone else's script in it could read the team's private pages.
- **Never copy a page or its files anywhere else** to get around the sign-in.
- The Worker changes only by `deploy`, which needs the Cloudflare account's credentials. Publishing needs only the
  publish token in the file `crit.config.ts` names; never ask for its value in a chat.
