import express from "express";
import * as path from "node:path";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { Client } from "@notionhq/client";

const envResult = dotenv.config({ override: true });
if (envResult.error) {
  console.error("Dotenv Error:", envResult.error);
}

export async function createServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  // API Routes
  app.post("/api/chat", async (req, res) => {
    const startTime = Date.now();
    console.time("ChatRequest");
    const { messages } = req.body;

    console.log(`[Chat API] Received request with ${messages?.length || 0} messages`);

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Messages array is required" });
    }

    try {
      const geminiApiKey = (
        process.env.GEMINI_API_KEY || 
        process.env.API_KEY || 
        ""
      ).trim();
      
      const notionApiKey = (process.env.NOTION_API_KEY || "").trim();
      const notionPageId = (process.env.NOTION_PAGE_ID || "").trim();

      if (!geminiApiKey) console.error("[Chat API] GEMINI_API_KEY is missing!");
      if (!notionApiKey) console.error("[Chat API] NOTION_API_KEY is missing!");
      if (!notionPageId) console.error("[Chat API] NOTION_PAGE_ID is missing!");

      if (!geminiApiKey || !notionApiKey || !notionPageId) {
        return res.status(500).json({ 
          error: "Missing API keys. Please ensure GEMINI_API_KEY, NOTION_API_KEY, and NOTION_PAGE_ID are set in your environment variables."
        });
      }

      const ai = new GoogleGenAI({ apiKey: geminiApiKey });
      const notion = new Client({ auth: notionApiKey });

      const tools = [
        {
          functionDeclarations: [
            {
              name: "create_page",
              description: "Create a new Notion page with structured content.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: "The title of the page." },
                  content_blocks: { 
                    type: Type.ARRAY, 
                    items: { type: Type.OBJECT }, 
                    description: "Array of Notion block objects (heading_1, paragraph, bulleted_list_item, etc.)" 
                  },
                  parent_id: { type: Type.STRING, description: "Optional parent page ID. Defaults to the root." }
                },
                required: ["title", "content_blocks"]
              }
            },
            {
              name: "update_page_content",
              description: "Add or append content blocks to an existing Notion page.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  page_id: { type: Type.STRING, description: "The ID of the page to update." },
                  content_blocks: { type: Type.ARRAY, items: { type: Type.OBJECT }, description: "Blocks to append." }
                },
                required: ["page_id", "content_blocks"]
              }
            },
            {
              name: "get_page_content",
              description: "Retrieve the content blocks of a Notion page.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  page_id: { type: Type.STRING, description: "The ID of the page." }
                },
                required: ["page_id"]
              }
            },
            {
              name: "create_database",
              description: "Create a new database in Notion.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  parent_id: { type: Type.STRING, description: "Parent page ID." },
                  title: { type: Type.STRING, description: "Database title." },
                  properties: { type: Type.OBJECT, description: "Database schema (e.g., { 'Name': { 'title': {} }, 'Status': { 'select': { 'options': [...] } } })" }
                },
                required: ["parent_id", "title", "properties"]
              }
            },
            {
              name: "add_database_row",
              description: "Add a row (page) to a Notion database.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  database_id: { type: Type.STRING, description: "The ID of the database." },
                  properties: { type: Type.OBJECT, description: "Row properties matching the database schema." }
                },
                required: ["database_id", "properties"]
              }
            },
            {
              name: "update_database_row",
              description: "Update properties of an existing row in a Notion database.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  page_id: { type: Type.STRING, description: "The ID of the row (page) to update." },
                  properties: { type: Type.OBJECT, description: "Properties to update." }
                },
                required: ["page_id", "properties"]
              }
            },
            {
              name: "list_database_rows",
              description: "List rows from a Notion database.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  database_id: { type: Type.STRING, description: "The ID of the database." },
                  filter: { type: Type.OBJECT, description: "Optional filter." },
                  sorts: { type: Type.ARRAY, items: { type: Type.OBJECT }, description: "Optional sorts." }
                },
                required: ["database_id"]
              }
            },
            {
              name: "search_notion",
              description: "Search for pages or databases in Notion.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  query: { type: Type.STRING, description: "Search query." },
                  filter: { type: Type.OBJECT, description: "Optional filter (e.g., { property: 'object', value: 'page' })" }
                },
                required: ["query"]
              }
            },
            {
              name: "archive_page",
              description: "Archive (delete) a Notion page.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  page_id: { type: Type.STRING, description: "The ID of the page to archive." }
                },
                required: ["page_id"]
              }
            },
            {
              name: "generate_image",
              description: "Generate an image based on a prompt and return its URL.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  prompt: { type: Type.STRING, description: "Description of the image to generate." }
                },
                required: ["prompt"]
              }
            }
          ]
        }
      ];

      // Optimize history: only keep last 6 messages to reduce token overhead and speed up processing
      const lastMessage = messages[messages.length - 1].content;
      const historyLimit = 6;
      const recentMessages = messages.slice(-historyLimit - 1, -1);
      
      const history = recentMessages.map(m => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.content }]
      }));

      const systemInstruction = `You are a high-speed AI Notion assistant.
      Goal: Execute user requests in Notion with maximum efficiency.
      
      Guidelines:
      - Be extremely concise.
      - Execute multiple tools in parallel if possible.
      - If you need to search, do it first, then act.
      - Default parent_id is ${notionPageId}.
      - For images, use generate_image.
      - Once actions are complete, provide a very brief summary.`;

      // Fast-path for simple greetings or short messages (less than 20 chars)
      const isSimpleMessage = lastMessage.length < 20 && 
        !lastMessage.toLowerCase().includes("notion") && 
        !lastMessage.toLowerCase().includes("page") &&
        !lastMessage.toLowerCase().includes("create") &&
        !lastMessage.toLowerCase().includes("update");

      if (isSimpleMessage) {
        const fastResponse = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [{ role: "user", parts: [{ text: lastMessage }] }],
          config: {
            systemInstruction: "You are a helpful assistant. Respond very briefly to greetings or simple chat.",
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }
          },
        });
        console.timeEnd("ChatRequest");
        return res.json({ content: fastResponse.text || "Hello! How can I help you with Notion today?" });
      }
      
      // Agentic Loop
      let currentHistory = [
        ...history,
        { role: "user", parts: [{ text: lastMessage }] }
      ];
      
      let finalResponseText = "";
      let turnCount = 0;
      const MAX_TURNS = (process.env.VERCEL || process.env.NETLIFY) ? 2 : 5;

      while (turnCount < MAX_TURNS) {
        console.log(`[Chat API] Starting turn ${turnCount + 1}/${MAX_TURNS}`);
        console.time(`Turn ${turnCount + 1}`);
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: currentHistory,
          config: {
            systemInstruction,
            tools: tools,
            thinkingConfig: { thinkingLevel: (process.env.VERCEL || process.env.NETLIFY) ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW }
          },
        });
        console.timeEnd(`Turn ${turnCount + 1}`);

        const functionCalls = response.functionCalls;
        
        if (!functionCalls || functionCalls.length === 0) {
          finalResponseText = response.text;
          break;
        }

        // Execute tools in parallel where possible
        const toolResults = await Promise.all(functionCalls.map(async (call) => {
          const { name, args, id } = call;
          console.log(`[Turn ${turnCount}] Executing tool: ${name}`);

          try {
            let result;
            switch (name) {
              case "create_page":
                result = await notion.pages.create({
                  parent: { page_id: (args.parent_id as string) || notionPageId },
                  properties: { title: { title: [{ text: { content: args.title as string } }] } } as any,
                  children: args.content_blocks as any
                });
                break;
              case "update_page_content":
                result = await notion.blocks.children.append({
                  block_id: args.page_id as string,
                  children: args.content_blocks as any
                });
                break;
              case "get_page_content":
                result = await notion.blocks.children.list({ block_id: args.page_id as string });
                break;
              case "create_database":
                result = await notion.databases.create({
                  parent: { type: "page_id", page_id: (args.parent_id as string) || notionPageId } as any,
                  title: [{ text: { content: args.title as string } }],
                  properties: args.properties as any
                } as any);
                break;
              case "add_database_row":
                result = await notion.pages.create({
                  parent: { database_id: args.database_id as string },
                  properties: args.properties as any
                });
                break;
              case "update_database_row":
                result = await notion.pages.update({
                  page_id: args.page_id as string,
                  properties: args.properties as any
                });
                break;
              case "list_database_rows":
                result = await (notion.databases as any).query({
                  database_id: args.database_id as string,
                  filter: args.filter as any,
                  sorts: args.sorts as any
                });
                break;
              case "search_notion":
                result = await notion.search({
                  query: args.query as string,
                  filter: args.filter as any
                });
                break;
              case "archive_page":
                result = await notion.pages.update({
                  page_id: args.page_id as string,
                  archived: true
                });
                break;
              case "generate_image":
                const imgResponse = await ai.models.generateContent({
                  model: "gemini-2.5-flash-image",
                  contents: args.prompt as string
                });
                let base64Image = "";
                for (const part of imgResponse.candidates[0].content.parts) {
                  if (part.inlineData) {
                    base64Image = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                    break;
                  }
                }
                result = { imageUrl: base64Image };
                break;
              default:
                result = { error: "Unknown tool" };
            }
            return { name, result, id };
          } catch (err: any) {
            console.error(`Tool error (${name}):`, err);
            return { name, error: err.message, id };
          }
        }));

        // Add model's call and tool's response to history
        currentHistory.push({ role: "model", parts: response.candidates[0].content.parts as any });
        currentHistory.push({ 
          role: "user", 
          parts: toolResults.map(r => ({ 
            functionResponse: {
              name: r.name,
              response: r.result || { error: r.error },
              id: r.id
            }
          })) as any
        });

        turnCount++;
      }

      // If we exited the loop due to MAX_TURNS, get a final summary
      if (turnCount === MAX_TURNS && !finalResponseText) {
        const finalResponse = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: currentHistory,
          config: {
            systemInstruction: "You have reached the maximum number of turns. Please provide a final summary of what you have accomplished so far and any errors encountered.",
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }
          },
        });
        finalResponseText = finalResponse.text || "I've reached the maximum number of steps for this task. Please check your Notion workspace for the results.";
      }

      // Final cleanup and timing - Removed artificial delay for serverless compatibility
      const totalTime = Date.now() - startTime;
      console.timeEnd("ChatRequest");
      console.log(`[Chat API] Request completed in ${totalTime}ms`);
      res.json({ content: finalResponseText || "I've completed the requested actions in your Notion workspace." });

    } catch (error: any) {
      console.timeEnd("ChatRequest");
      console.error("Agentic Error:", error);
      res.status(500).json({ error: error.message || "An unexpected error occurred in the workspace assistant." });
    }
  });

  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL && !process.env.NETLIFY) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (!process.env.NETLIFY && !process.env.VERCEL) {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  if (!process.env.VERCEL && !process.env.NETLIFY) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }

  return app;
}

// Start server if running directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("server.ts") || 
  process.argv[1].endsWith("server.js") || 
  process.argv[1].includes("node_modules/.bin/tsx")
);

if (isMain && !process.env.NETLIFY && !process.env.VERCEL) {
  createServer().catch(err => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
