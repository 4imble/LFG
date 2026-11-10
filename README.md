# LFG: let's flipping go

A shared, AI-assisted trip planner. Each trip is a **plan** (a sabbatical, a holiday with friends…) with flexible **tabs** you or the assistant create as ideas pile up. Dump flights, links, prices, countries and things to do; it keeps them organised, remembers price changes, and saves every edit as a version you can look back at or restore.

## Features

- **Multiple plans**, each with its own dates, travellers, summary and countdown.
- **Fluid tabs** in five layouts: cards, table, timeline, checklist and notes. Tabs are created, renamed, merged and reordered as needed.
- **Structured items**: flights, stays, places, activities, to-dos, costs and more, with dates, prices, links, tags and any extra details.
- **Price history**: change a price and the old one is kept (shown as "↓ from £640").
- **Overview**: booked and shortlisted totals, money by kind of item, status breakdown, open to-dos, countries, pinned items, and an itinerary across every tab with "Day 12" labels once the trip has dates.
- **Finding things**: search the whole plan (press `/`), click a tag or country to filter by it, and sort any tab by date, price, name or latest change.
- **Quick edits**: a quick-add box on every tab, a status menu on every item, duplicate, and Undo after deleting, moving or an assistant change.
- **Take it with you**: download the dated items as a calendar file (.ics), export a JSON backup, or print. It can be added to a phone's home screen.
- **Assistant** (Claude): paste a brain dump or ask for changes ("the Tokyo flight is now £540", "tidy the inbox into tabs") and it edits the plan through the same validated operations as the UI. It can search the web when you ask it to look something up, and shows what it is doing while it works.
- **History**: every change (manual, assistant or restore) is a version showing who made it and what changed. You can preview any old version and restore it.
- **Per-plan passwords**: `APP_PASSWORD` is the admin password. It opens the admin page, where you can see every plan, create plans, set or reset each plan's password and copy its share link. A plan's own password opens only that plan, and anyone holding it can edit that plan. Resetting a plan's password signs out everyone who used the old one. A new plan has no password, so only the admin can open it until you set one. People give a display name so changes are attributed.
- Picks up changes from other people every 20 seconds, tells you how much changed since your last visit, and works on phones.
- Keyboard: `/` search, `n` new item on the current tab, `a` assistant, `Esc` close.

## Running on Coolify

1. Create a **PostgreSQL** resource in Coolify and copy its connection URL.
2. Add this repo as an application using the **Dockerfile** build pack. The port is `3000`.
3. Set these environment variables:
   - `DATABASE_URL`: the Postgres URL from step 1.
   - `APP_PASSWORD`: the admin password. Plan passwords are set on the admin page.
   - `ANTHROPIC_API_KEY`: turns on the assistant (optional).
4. Deploy. On startup the app runs any pending database migrations against `DATABASE_URL` (tracked in a `schema_migrations` table), so new versions upgrade the schema themselves.

The assistant's model (Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.2) and effort are chosen on the admin page. Optional settings: `AI_MODEL` and `AI_EFFORT` set the defaults until you pick something on the admin page (default `claude-opus-5-5` at `medium`), `SESSION_SECRET` (defaults to one derived from the password, so changing the password signs everyone out) and `PORT`.

Health check: `GET /healthz`.

## Local development

```sh
npm install
cp .env.example .env   # fill in the values
node --env-file=.env --watch src/server.js
```

Tests: `npm test` runs the unit tests. Set `TEST_DATABASE_URL` to a throwaway Postgres database to also run the API end-to-end test. That test drops and recreates the tables and uses a fake Anthropic API.

## How it fits together

- `src/ops.js`: the plan document model and the only way it changes (`add_tab`, `add_item`, `update_item`, …). Both the UI and the assistant use these operations.
- `src/ai.js`: the assistant loop. Each operation is a Claude tool, plus web search. The assistant works on a draft, and the result is saved as one version.
- `src/db.js`: Postgres storage and migrations. A plan row holds the current document, and `versions` holds a snapshot of every change.
- `src/server.js`: the Express API and static hosting. Assets are served under `/v/<hash of public/>/`, so a deploy changes every asset URL and nothing stale is served from a cache.
- `public/`: the front end (plain ES modules, no build step).
  - `app.js`: rendering, events, polling and start-up.
  - `core.js`: shared state, API calls, routing, dialogs, menus and toasts.
  - `views.js`: HTML for each screen. `editors.js`: the dialogs.
  - `lib/`: pure helpers (formatting, search, sorting, totals, calendar export, version diffs), unit tested in `test/lib.test.js`.
