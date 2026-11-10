// The plan assistant: Claude with one tool per plan operation, plus web search.
// It works on a draft copy of the plan; the server saves the result as a single
// version once the assistant has finished.

import Anthropic from '@anthropic-ai/sdk';
import { applyOp, OpError, ITEM_KINDS, STATUSES, LAYOUTS } from './ops.js';

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.AI_EFFORT || 'medium';
const MAX_STEPS = 30;

let client = null;
export function aiEnabled() { return Boolean(process.env.ANTHROPIC_API_KEY); }
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const itemSchema = {
  type: 'object',
  description: 'Fields of a plan item. Only include fields you know; leave the rest out.',
  properties: {
    kind: { type: 'string', enum: ITEM_KINDS, description: 'What sort of thing this is; picks the icon and card style.' },
    title: { type: 'string', description: 'Short name, e.g. "LHR → NRT, ANA" or "Kyoto".' },
    subtitle: { type: 'string', description: 'One-line secondary info, e.g. airline + flight number, neighbourhood.' },
    description: { type: 'string', description: 'Longer notes. Light markdown allowed: **bold**, *italic*, "- " bullets, links.' },
    status: { type: 'string', enum: STATUSES },
    date: { type: 'string', description: 'Start date YYYY-MM-DD (or YYYY-MM if only the month is known).' },
    endDate: { type: 'string', description: 'End date YYYY-MM-DD or YYYY-MM.' },
    time: { type: 'string', description: 'Time or time range as free text, e.g. "09:40 → 17:15".' },
    location: { type: 'string', description: 'City / area / venue.' },
    country: { type: 'string' },
    price: {
      type: 'object',
      description: 'Current price. Changing it automatically records the old price in the item\'s price history.',
      properties: {
        amount: { type: 'number' },
        currency: { type: 'string', description: 'ISO code, default GBP.' },
        note: { type: 'string', description: 'e.g. "per person", "total for 2", "per night".' },
      },
      required: ['amount'],
    },
    links: {
      type: 'array',
      items: { type: 'object', properties: { url: { type: 'string' }, label: { type: 'string' } }, required: ['url'] },
    },
    tags: { type: 'array', items: { type: 'string' } },
    details: {
      type: 'object',
      description: 'Any other key/value facts worth showing, e.g. {"Baggage": "23kg", "Duration": "14h 5m", "Visa": "30 days on arrival"}.',
      additionalProperties: { type: 'string' },
    },
    pinned: { type: 'boolean', description: 'Pinned items show first and on the overview.' },
    image: { type: 'string', description: 'Optional https image URL.' },
  },
};

const tools = [
  {
    name: 'view_plan',
    description: 'Return the current plan (after any changes you made this turn) as JSON, including all tab and item ids.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_plan_details',
    description: 'Change the plan\'s own details: title, emoji, subtitle, summary (markdown), start/end dates (YYYY-MM-DD) and travellers.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, emoji: { type: 'string' }, subtitle: { type: 'string' },
        summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
        travellers: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'add_tab',
    description: `Create a new tab (section). Layouts: cards (default, visual grid), table (comparisons such as flights or prices), timeline (date-ordered itinerary), list (checklists / to-dos), notes (long-form notes). Returns the new tab id.`,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, emoji: { type: 'string' }, description: { type: 'string' },
        layout: { type: 'string', enum: LAYOUTS },
        after_tab_id: { type: 'string', description: 'Insert after this tab; omit to add at the end.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_tab',
    description: 'Rename a tab or change its emoji, description or layout.',
    input_schema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' }, title: { type: 'string' }, emoji: { type: 'string' },
        description: { type: 'string' }, layout: { type: 'string', enum: LAYOUTS },
      },
      required: ['tab_id'],
    },
  },
  {
    name: 'delete_tab',
    description: 'Delete a tab. If it still has items you must give move_items_to_tab_id so nothing is lost.',
    input_schema: {
      type: 'object',
      properties: { tab_id: { type: 'string' }, move_items_to_tab_id: { type: 'string' } },
      required: ['tab_id'],
    },
  },
  {
    name: 'reorder_tabs',
    description: 'Set the tab order. Tabs not listed keep their relative order at the end.',
    input_schema: { type: 'object', properties: { tab_ids: { type: 'array', items: { type: 'string' } } }, required: ['tab_ids'] },
  },
  {
    name: 'add_item',
    description: 'Add an item (flight, stay, place, activity, idea, note, to-do, cost…) to a tab. Returns the new item id.',
    input_schema: {
      type: 'object',
      properties: { tab_id: { type: 'string' }, item: { ...itemSchema, required: ['title'] } },
      required: ['tab_id', 'item'],
    },
  },
  {
    name: 'update_item',
    description: 'Change some fields of an existing item. Only the fields given are changed. Arrays (links, tags) and details replace the old value, so include existing entries you want to keep.',
    input_schema: {
      type: 'object',
      properties: { item_id: { type: 'string' }, changes: itemSchema },
      required: ['item_id', 'changes'],
    },
  },
  {
    name: 'move_item',
    description: 'Move an item to another tab (optionally to a position, 0 = top).',
    input_schema: {
      type: 'object',
      properties: { item_id: { type: 'string' }, to_tab_id: { type: 'string' }, position: { type: 'integer' } },
      required: ['item_id', 'to_tab_id'],
    },
  },
  {
    name: 'delete_item',
    description: 'Delete an item. Only do this when asked, or when merging a duplicate into another item.',
    input_schema: { type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'] },
  },
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
];

const SYSTEM = `You are the planning assistant inside "LFG", a shared trip-planning web app. A small group (often a couple, sometimes friends) dumps thoughts into a plan over many months: flights with links and prices, countries and cities they might visit, things to do, places to stay, budgets, admin. Your job is to keep each plan beautifully organised so it is a pleasure to read.

How plans work:
- A plan has details (title, emoji, subtitle, summary, start/end dates, travellers) and an ordered list of tabs.
- Tabs are fluid. Create, rename, merge, reorder or remove tabs to fit whatever the data needs; there is no fixed set. Good tabs are few and meaningful (e.g. "Route", "Flights", "Japan", "Stays", "Budget", "Admin & visas"). A tab per country can work well for a long multi-country trip. Pick each tab's layout to suit its content.
- Each tab holds items. Use the most specific kind, fill structured fields (dates, price, location, country, links, details) rather than burying facts in the description, and keep titles short.
- The "Inbox" tab is where unsorted dumps go. When asked to tidy up, sort Inbox items into proper tabs.
- Statuses: idea → considering → shortlisted → booked → done, or rejected. Default to "idea" for new suggestions unless the user says otherwise.
- Prices: always record currency. When a user gives an updated price for something that already exists, update that item's price (history is kept automatically) instead of adding a duplicate.

How to work:
- Call view_plan first to see the current state and ids, unless you already have it this turn.
- Make the changes with the tools. Do several independent changes in parallel when you can.
- Never delete user content unless asked; when tidying, move or merge instead.
- Only use web_search when the user asks you to look something up, or a fact is needed to do what they asked. Cite the link in the item when you add researched facts.
- Never invent prices, flight numbers or bookings. If something is a rough estimate, say so in the price note.
- When you are done, reply in a short, friendly message (1-4 sentences, or a few bullets) saying what you changed. Answer questions about the plan directly. Use British English.`;

function toHistory(chat) {
  // Rebuild alternating user/assistant text turns from stored chat rows.
  const msgs = [];
  for (const row of chat) {
    const role = row.role === 'assistant' ? 'assistant' : 'user';
    const text = role === 'user' ? `${row.author || 'Someone'}: ${row.text}` : row.text;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else msgs.push({ role, content: text });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  while (msgs.length && msgs[msgs.length - 1].role !== 'assistant') msgs.pop();
  return msgs;
}

// Runs the assistant. Returns { reply, ops, results } where ops are the
// successful operations (so the server can replay them if the plan changed
// while the assistant was thinking).
export async function runAssistant({ doc, message, author, chat = [], today = new Date() }) {
  const draft = structuredClone(doc);
  const applied = [];
  const results = [];
  const messages = [
    ...toHistory(chat),
    {
      role: 'user',
      content: `Today is ${today.toISOString().slice(0, 10)}. Message from ${author || 'a planner'}:\n\n${message}`,
    },
  ];

  let reply = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      messages,
    });

    if (response.stop_reason === 'refusal') {
      reply = 'Sorry, I can\'t help with that request.';
      break;
    }

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (text) reply = text;
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason !== 'tool_use') break;

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let content;
      let isError = false;
      try {
        if (block.name === 'view_plan') {
          content = JSON.stringify(draft);
        } else {
          const op = { type: block.name, ...(block.input || {}) };
          const res = applyOp(draft, op, { author: `AI (for ${author || 'planner'})` });
          // Replays must target the same ids, so pin generated ids onto the op.
          if (res.id && op.type === 'add_tab') op.__id = res.id;
          if (res.id && op.type === 'add_item') op.__id = res.id;
          applied.push(op);
          results.push(res.text);
          content = res.id ? `${res.text} (id: ${res.id})` : res.text;
        }
      } catch (err) {
        isError = true;
        content = err instanceof OpError ? `Error: ${err.message}` : `Error: ${String(err?.message || err)}`;
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: isError || undefined });
    }
    messages.push({ role: 'user', content: toolResults });
    if (step === MAX_STEPS - 1) reply ||= 'I ran out of steps before finishing; some changes may be missing.';
  }

  return { reply: reply || 'Done.', ops: applied, results, draft };
}
