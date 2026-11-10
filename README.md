# LFG: let's flipping go

A shared, AI-assisted trip planner. Each trip is a **plan** (a sabbatical, a holiday with friends…) with flexible **tabs** you or the assistant create as ideas pile up. Dump flights, links, prices, countries and things to do; it keeps them organised, remembers price changes, and saves every edit as a version you can look back at or restore.

## Features

- **Multiple plans**, each with its own dates, travellers, summary and countdown.
- **Fluid tabs** in five layouts: cards, table, timeline, checklist and notes. Tabs are created, renamed, merged and reordered as needed.
- **Structured items**: flights, stays, places, activities, to-dos, costs and more, with dates, prices, links, tags and any extra details.
- **Price history**: change a price and the old one is kept (shown as "↓ from £640").
- **Overview**: booked and shortlisted totals, status breakdown, countries, pinned items, and an itinerary across every tab.
- **Assistant** (Claude): paste a brain dump or ask for changes ("the Tokyo flight is now £540", "tidy the inbox into tabs") and it edits the plan through the same validated operations as the UI. It can search the web when you ask it to look something up.
- **History**: every change (manual, assistant or restore) is a version showing who made it and what changed. You can preview any old version and restore it.
- **One shared password**: anyone with the link and password can edit. People give a display name so changes are attributed.
- Picks up changes from other people every 20 seconds, and works on phones.

## Running on Coolify

1. Create a **PostgreSQL** resource in Coolify and copy its connection URL.
2. Add this repo as an application using the **Dockerfile** build pack. The port is `3000`.
3. Set these environment variables:
   - `DATABASE_URL`: the Postgres URL from step 1.
   - `APP_PASSWORD`: the shared password.
   - `ANTHROPIC_API_KEY`: turns on the assistant (optional).
4. Deploy. On startup the app runs any pending database migrations against `DATABASE_URL` (tracked in a `schema_migrations` table), so new versions upgrade the schema themselves.

Optional settings: `AI_MODEL` (default `claude-opus-5-5`), `AI_EFFORT` (default `medium`; `low` is cheaper, `high` thinks harder), `SESSION_SECRET` (defaults to one derived from the password, so changing the password signs everyone out) and `PORT`.

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
- `src/server.js`: the Express API and static hosting.
- `public/`: the front end (plain JS, no build step).
