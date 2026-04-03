# Gemini Notion Sync

Automatically generate structured Notion pages from text prompts using Google Gemini AI.

## Setup Instructions

### 1. Google Gemini API Key
- Go to [Google AI Studio](https://aistudio.google.com/app/apikey).
- Create a new API key.
- In this app (AI Studio Build), click the **Secrets** panel (bottom left or top right gear icon).
- Add a secret named `GEMINI_API_KEY` and paste your key.

### 2. Notion Integration
- Go to [Notion My Integrations](https://www.notion.so/my-integrations).
- Click **+ New integration**.
- Give it a name (e.g., "Gemini Sync") and select the workspace.
- Copy the **Internal Integration Token**.
- Add a secret named `NOTION_API_KEY` in AI Studio with this token.

### 3. Notion Page ID
- Open the Notion page where you want new notes to be created.
- Copy the ID from the URL. It's the 32-character string at the end of the URL (e.g., `https://www.notion.so/My-Page-8f7...`).
- Add a secret named `NOTION_PAGE_ID` in AI Studio with this ID.

### 4. Share Page with Integration
- In Notion, go to your target page.
- Click the **"..."** (top right) -> **Add connections**.
- Search for your integration name and select it.

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the root directory:
   ```env
   GEMINI_API_KEY=your_gemini_key
   NOTION_API_KEY=your_notion_secret
   NOTION_PAGE_ID=your_notion_page_id
   ```
3. Run the development server:
   ```bash
   npm run dev
   ```

## Troubleshooting

- **API key not valid**: Ensure you have copied the key correctly and it is set in the **Secrets** panel.
- **Could not find page**: Ensure you have shared the Notion page with your integration.
- **Missing permissions**: Ensure your Notion integration has "Insert content" and "Update content" capabilities enabled.
