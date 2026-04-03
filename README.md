# AI Notion Assistant Deployment Guide

This guide will help you deploy your AI Notion Assistant to Vercel or Netlify.

## Environment Variables

You MUST set the following environment variables in your deployment platform:

- `GEMINI_API_KEY`: Your Google Gemini API Key.
- `NOTION_API_KEY`: Your Notion Internal Integration Token.
- `NOTION_PAGE_ID`: The ID of the parent Notion page.

Optional (recommended for free-tier stability):

- `GEMINI_BUDGET_MODE=true`
- `GEMINI_MODEL_PRIMARY=gemini-3.1-flash-lite-preview`
- `GEMINI_MODEL_FALLBACKS=gemini-3-flash-preview`
- `ENABLE_WEB_SEARCH=false`
- `ENABLE_IMAGE_GENERATION=false`

Optional backend safeguards (already enabled with defaults):

- `HARD_QUOTA_COOLDOWN_MS=600000`
- `REQUEST_WINDOW_MS=60000`
- `MAX_REQUESTS_PER_WINDOW=25`
- `MAX_MESSAGE_CHARS=6000`
- `MAX_HISTORY_MESSAGES=24`
- `RESPONSE_CACHE_TTL_MS=90000`
- `ENABLE_HARD_QUOTA_FALLBACK=true`
- `METRICS_TOKEN=<optional secret for /api/metrics>`

## Vercel Deployment

1.  Connect your GitHub repository to Vercel.
2.  Add the environment variables listed above.
3.  Vercel should automatically detect the Vite project.
4.  The `vercel.json` file is already configured to handle the Express backend.

## Netlify Deployment

1.  Connect your GitHub repository to Netlify.
2.  Set the build command to `npm run build`.
3.  Set the publish directory to `dist`.
4.  Add the environment variables: `GEMINI_API_KEY`, `NOTION_API_KEY`, `NOTION_PAGE_ID`.
5.  The `netlify.toml` and `functions/api.ts` are already configured to handle the Express backend as a Netlify Function.

## Local Development

```bash
npm install
npm run dev
```

## Features

- **Autonomous Agent**: Multi-turn reasoning loop for complex tasks.
- **Fast Response**: Optimized with Gemini Flash and parallel execution.
- **Image Generation**: Generate and embed images directly into Notion.
- **Robust Error Handling**: Self-correcting agentic behavior.

## Quota And Rate-Limit Troubleshooting

If you see `429` errors on deployment, there are two possible cases:

- **Hard quota exhausted**: Your Gemini API key has no remaining quota/billing.
- **Temporary rate limit**: Too many requests in a short window.

This project now handles both cases differently:

- Returns `429` with `code: "hard_quota"` for exhausted quota (no pointless retries).
- Returns `429` with `code: "rate_limited"` for transient limits (automatic retries are applied).

Additional protections now enabled:

- Lightweight client-level request throttling to prevent burst abuse from draining quota.
- Message normalization and caps to control payload/token growth.
- Short-lived response caching for non-mutating prompts to reduce repeated Gemini calls.
- Graceful fallback mode for hard-quota scenarios (returns actionable response instead of hard failure).

## Observability

Use the runtime metrics endpoint to monitor request health:

- `GET /api/metrics`

Returned counters include:

- total requests, successes, failures
- client rate-limit hits
- Gemini rate-limit and hard-quota events
- cache hits/writes
- tool call counts/failures
- fallback responses served

For production safety, set `METRICS_TOKEN` and call:

- `GET /api/metrics?token=YOUR_TOKEN`
or
- `Authorization: Bearer YOUR_TOKEN`

For hard quota issues:

1. Open Google AI Studio quota/billing settings and increase available quota.
2. Replace `GEMINI_API_KEY` in Vercel/Netlify env vars if needed.
3. Redeploy and verify `/api/health` returns all required envs as present.

## Run On Free Tier (No Billing)

If you do not want paid billing, keep usage within free Gemini limits:

1. Set `GEMINI_BUDGET_MODE=true`.
2. Keep `ENABLE_WEB_SEARCH=false` and `ENABLE_IMAGE_GENERATION=false`.
3. Use shorter prompts and avoid repeated retries for the same request.

In budget mode, the backend automatically reduces token usage and limits multi-turn agent loops to preserve free quota.
