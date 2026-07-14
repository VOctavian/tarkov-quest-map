# CLAUDE.md — Tarkov Quest Map

## Version indicator workflow

`index.html` shows a barely-visible version number in the bottom-left
corner (`#app-version`, driven by the `APP_VERSION` JS constant near the
top of the `<script>` block). The user uses it to tell, at a glance,
whether GitHub Pages has finished deploying the latest push yet.

**Follow this automatically, without being asked, every time a push happens:**

1. **While work is in progress** (uncommitted local changes not yet pushed),
   `APP_VERSION` must be `<last-pushed-integer>.1`
   (e.g. if the last push shipped version `7`, local should read `7.1`).
2. **Right before running `git push`**, bump `APP_VERSION` to the next whole
   integer (e.g. `7.1` → `8`) and include that change in the commit being
   pushed. This integer is what ends up live on GitHub Pages once the
   deploy finishes.
3. **Immediately after the push completes**, bump `APP_VERSION` again to
   `<that-integer>.1` (e.g. `8` → `8.1`) as a new local-only change. Do not
   push this bump by itself — it rides along with the next push.

Net effect: while developing, local always shows `X.1`. GitHub Pages keeps
showing the last-pushed integer `X` until the new deploy finishes, then
flips to the new integer — that's the user's signal that the deploy landed.
