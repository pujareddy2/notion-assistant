import express from "express";
import { createServer as createViteServer } from "vite";
import * as path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { Client } from "@notionhq/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envResult = dotenv.config({ override: true });
if (envResult.error) {
  console.error("Dotenv Error:", envResult.error);
}

const PUBLIC_DIR = path.join(process.cwd(), "public");
const GENERATED_DIR = path.join(PUBLIC_DIR, "generated");

if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: "50mb" }));
  app.use("/generated", express.static(GENERATED_DIR));

  // API Routes
  app.post("/api/chat", async (req, res) => {
    const startTime = Date.now();
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Messages array is required" });
    }

    try {
      const geminiApiKey = (
        (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) || 
        (process.env.API_KEY && process.env.API_KEY.trim()) || 
        (process.env.NEXT_PUBLIC_GEMINI_API_KEY && process.env.NEXT_PUBLIC_GEMINI_API_KEY.trim()) || 
        ""
      ).trim();
      
      const notionApiKey = (process.env.NOTION_API_KEY || "").trim();
      const notionPageId = (process.env.NOTION_PAGE_ID || "").trim();

      if (!geminiApiKey || !notionApiKey || !notionPageId) {
        return res.status(500).json({ 
          error: "Missing API keys. Please ensure GEMINI_API_KEY, NOTION_API_KEY, and NOTION_PAGE_ID are set."
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

      const lastMessage = messages[messages.length - 1].content;
      const history = messages.slice(0, -1).map(m => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.content }]
      }));

      const systemInstruction = `You are an advanced autonomous AI workspace assistant for Notion. 
      Your goal is to manage, organize, and manipulate the user's Notion workspace with high precision and speed.
      
      Capabilities:
      - Create and update pages with structured content (headings, lists, code blocks).
      - Create and manage databases (add/update rows, query data).
      - Search for existing content to avoid duplicates and find relevant IDs.
      - Generate images for visual explanations.
      
      Guidelines:
      - If a user's request is complex, break it down into multiple tool calls.
      - You can call tools multiple times in a sequence to achieve a goal (e.g., search -> get content -> update).
      - Always generate high-quality, structured content.
      - If a tool fails, analyze the error and try an alternative approach (e.g., search for the correct ID).
      - Default parent_id is ${notionPageId}.
      - Be professional, helpful, and concise.
      
      Notion Block Structure:
      - heading_1/2/3: { rich_text: [{ text: { content: "Text" } }] }
      - paragraph: { rich_text: [{ text: { content: "Text" } }] }
      - bulleted_list_item: { rich_text: [{ text: { content: "Text" } }] }
      - to_do: { rich_text: [{ text: { content: "Text" } }] }
      - code: { rich_text: [{ text: { content: "Code" } }], language: "python" }`;

      // Agentic Loop
      let currentHistory = [
        ...history,
        { role: "user", parts: [{ text: lastMessage }] }
      ];
      
      let finalResponseText = "";
      let turnCount = 0;
      const MAX_TURNS = 5;

      while (turnCount < MAX_TURNS) {
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: currentHistory,
          config: {
            systemInstruction,
            tools: tools,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
          },
        });

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
                let imageUrl = "";
                for (const part of imgResponse.candidates[0].content.parts) {
                  if (part.inlineData) {
                    const fileName = `img_${Date.now()}.png`;
                    const filePath = path.join(GENERATED_DIR, fileName);
                    fs.writeFileSync(filePath, Buffer.from(part.inlineData.data, "base64"));
                    imageUrl = `${req.protocol}://${req.get("host")}/generated/${fileName}`;
                    break;
                  }
                }
                result = { imageUrl };
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

      // Final cleanup and timing
      const elapsedTime = Date.now() - startTime;
      if (elapsedTime < 10000) {
        await new Promise(resolve => setTimeout(resolve, 10000 - elapsedTime));
      }

      res.json({ content: finalResponseText || "I've completed the requested actions in your Notion workspace." });

    } catch (error: any) {
      console.error("Agentic Error:", error);
      res.status(500).json({ error: error.message || "An unexpected error occurred in the workspace assistant." });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
