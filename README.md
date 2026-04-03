# AI Notion Assistant Deployment Guide

This guide will help you deploy your AI Notion Assistant to Vercel or Netlify.

## Environment Variables

You MUST set the following environment variables in your deployment platform:

- `GEMINI_API_KEY`: Your Google Gemini API Key.
- `NOTION_API_KEY`: Your Notion Internal Integration Token.
- `NOTION_PAGE_ID`: The ID of the parent Notion page.

## Vercel Deployment

1.  Connect your GitHub repository to Vercel.
2.  Add the environment variables listed above.
3.  Vercel should automatically detect the Vite project.
4.  The `vercel.json` file is already configured to handle the Express backend.

## Netlify Deployment

1.  Connect your GitHub repository to Netlify.
2.  Set the build command to `npm run build`.
3.  Set the publish directory to `dist`.
4.  Add the environment variables.
5.  (Optional) You may need to adapt the backend to Netlify Functions if you want a full-stack experience on Netlify.

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
