import express from "express";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { createHash } from "crypto";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { Client } from "@notionhq/client";

type GeminiErrorKind = "hard_quota" | "rate_limited" | "service_unavailable" | "unknown";
let quotaCooldownUntil = 0;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const HARD_QUOTA_COOLDOWN_MS = parsePositiveInt(process.env.HARD_QUOTA_COOLDOWN_MS, 10 * 60 * 1000);
const REQUEST_WINDOW_MS = parsePositiveInt(process.env.REQUEST_WINDOW_MS, 60 * 1000);
const MAX_REQUESTS_PER_WINDOW = parsePositiveInt(process.env.MAX_REQUESTS_PER_WINDOW, 25);
const MAX_MESSAGE_CHARS = parsePositiveInt(process.env.MAX_MESSAGE_CHARS, 6000);
const MAX_HISTORY_MESSAGES = parsePositiveInt(process.env.MAX_HISTORY_MESSAGES, 24);
const CACHE_TTL_MS = parsePositiveInt(process.env.RESPONSE_CACHE_TTL_MS, 90 * 1000);
const ENABLE_HARD_QUOTA_FALLBACK = process.env.ENABLE_HARD_QUOTA_FALLBACK !== "false";
const METRICS_TOKEN = (process.env.METRICS_TOKEN || "").trim();

const requestCounters = new Map<string, { count: number; windowStart: number }>();
const responseCache = new Map<string, { content: string; expiresAt: number }>();
const runtimeMetrics = {
  startedAt: Date.now(),
  requestsTotal: 0,
  requestsSucceeded: 0,
  requestsFailed: 0,
  clientRateLimited: 0,
  geminiRateLimited: 0,
  geminiHardQuota: 0,
  cacheHits: 0,
  cacheWrites: 0,
  fallbackResponses: 0,
  toolCalls: 0,
  toolCallFailures: 0
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupInMemoryMaps(now = Date.now()) {
  for (const [key, entry] of requestCounters.entries()) {
    if (now - entry.windowStart > REQUEST_WINDOW_MS * 2) {
      requestCounters.delete(key);
    }
  }
  for (const [key, entry] of responseCache.entries()) {
    if (entry.expiresAt <= now) {
      responseCache.delete(key);
    }
  }
}

function getClientIp(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).split(",")[0].trim();
  }
  return req.ip || "unknown";
}

function getRateLimitDecision(ip: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
  const current = requestCounters.get(ip);
  if (!current || now - current.windowStart >= REQUEST_WINDOW_MS) {
    requestCounters.set(ip, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  current.count += 1;
  requestCounters.set(ip, current);

  if (current.count <= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((REQUEST_WINDOW_MS - (now - current.windowStart)) / 1000)
  );
  return { allowed: false, retryAfterSeconds };
}

function normalizeMessages(rawMessages: any[]): Array<{ role: "user" | "assistant"; content: string }> {
  return rawMessages
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant"))
    .map((m: any) => {
      const rawText = typeof m.content === "string" ? m.content : String(m.content ?? "");
      const trimmed = rawText.trim();
      const content = trimmed.length > MAX_MESSAGE_CHARS ? trimmed.slice(0, MAX_MESSAGE_CHARS) : trimmed;
      return {
        role: m.role,
        content
      };
    })
    .filter((m: any) => m.content.length > 0)
    .slice(-MAX_HISTORY_MESSAGES);
}

function isLikelyMutatingPrompt(prompt: string): boolean {
  return /(create|update|delete|archive|append|add\s+row|insert|remove|edit|modify|generate\s+image)/i.test(prompt);
}

function buildCacheKey(messages: Array<{ role: "user" | "assistant"; content: string }>, notionPageId: string): string {
  const payload = JSON.stringify({ messages, notionPageId });
  return createHash("sha256").update(payload).digest("hex");
}

function buildHardQuotaFallbackText(lastMessage: string, retryAfterSeconds: number): string {
  const normalized = lastMessage.trim().slice(0, 800);
  const mutating = isLikelyMutatingPrompt(normalized);
  const header = "Gemini quota is temporarily unavailable for this deployment key, so I am running in fallback mode.";
  const timing = `Estimated retry window: about ${retryAfterSeconds} seconds.`;

  if (mutating) {
    return [
      header,
      timing,
      "",
      "I did not run write actions yet to avoid partial updates.",
      "Prepared action plan:",
      "1. Validate target page/database exists and integration access is active.",
      "2. Re-run this exact request when quota resets.",
      "3. If urgent, split into smaller steps (search first, then update/create).",
      "",
      `Saved intent summary: ${normalized}`
    ].join("\n");
  }

  return [
    header,
    timing,
    "",
    "I can still provide a lightweight response without live Gemini reasoning:",
    `- Request understood: ${normalized}`,
    "- Suggestion: keep prompts short and avoid repeated retries during cooldown.",
    "- After cooldown, retry once to resume full Notion AI behavior."
  ].join("\n");
}

function getErrorMessage(error: any): string {
  if (typeof error?.message === "string" && error.message.length > 0) return error.message;
  if (typeof error?.error?.message === "string" && error.error.message.length > 0) return error.error.message;
  return "";
}

function classifyGeminiError(error: any): { kind: GeminiErrorKind; retryable: boolean; statusCode: number } {
  const message = getErrorMessage(error).toLowerCase();
  const status = String(error?.status || error?.error?.status || "").toUpperCase();
  const code = Number(error?.code ?? error?.error?.code);

  const isHardQuota =
    message.includes("exceeded your current quota") ||
    message.includes("billing details") ||
    message.includes("insufficient_quota") ||
    message.includes("quota exceeded");

  if (isHardQuota) {
    return { kind: "hard_quota", retryable: false, statusCode: 429 };
  }

  const isRateLimited =
    code === 429 ||
    status === "RESOURCE_EXHAUSTED" ||
    message.includes("resource_exhausted") ||
    message.includes("rate limit") ||
    message.includes("too many requests");

  if (isRateLimited) {
    return { kind: "rate_limited", retryable: true, statusCode: 429 };
  }

  const isUnavailable =
    code === 503 ||
    status === "UNAVAILABLE" ||
    message.includes("unavailable") ||
    message.includes("overloaded") ||
    message.includes("high demand") ||
    message.includes("503");

  if (isUnavailable) {
    return { kind: "service_unavailable", retryable: true, statusCode: 503 };
  }

  return { kind: "unknown", retryable: false, statusCode: 500 };
}

function getQuotaRetryAfterSeconds(now = Date.now()): number {
  if (quotaCooldownUntil <= now) return 0;
  return Math.max(1, Math.ceil((quotaCooldownUntil - now) / 1000));
}

// Helper for exponential backoff on Gemini API calls.
async function retryGenerateContent(ai: any, params: any) {
  const isServerless = !!(process.env.NETLIFY || process.env.VERCEL);
  const maxRetries = isServerless ? 3 : 5;
  const configuredPrimary = (process.env.GEMINI_MODEL_PRIMARY || "").trim();
  const configuredFallbacks = (process.env.GEMINI_MODEL_FALLBACKS || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  const preferredModels = isServerless
    ? ["gemini-3.1-flash-lite-preview", "gemini-3-flash-preview"]
    : ["gemini-3-flash-preview", "gemini-3.1-flash-lite-preview"];

  const modelsToTry = Array.from(
    new Set([
      params.model,
      configuredPrimary,
      ...configuredFallbacks,
      ...preferredModels
    ].filter(Boolean))
  );

  let lastError;
  for (const model of modelsToTry) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await ai.models.generateContent({ ...params, model });
      } catch (error: any) {
        lastError = error;
        const errorInfo = classifyGeminiError(error);
        const errorMsg = getErrorMessage(error);

        if (errorInfo.kind === "hard_quota") {
          throw error;
        }

        if (errorInfo.retryable && i < maxRetries - 1) {
          const baseDelay = errorInfo.kind === "rate_limited" ? 2500 : 1200;
          const delay = Math.pow(2, i) * baseDelay + Math.random() * 800;
          console.warn(
            `[Chat API] Gemini transient failure (${errorInfo.kind}) for ${model} ` +
            `(attempt ${i + 1}/${maxRetries}). Retrying in ${Math.round(delay)}ms... ` +
            `Error: ${errorMsg.substring(0, 120)}`
          );
          await sleep(delay);
          continue;
        }

        break;
      }
    }
  }
  throw lastError;
}

export async function createServer() {
  // Load environment variables in non-production environments
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL && !process.env.NETLIFY) {
    const envResult = dotenv.config({ override: true });
    if (envResult.error) {
      console.warn("Dotenv Warning (Expected in some environments):", envResult.error.message);
    }
  }

  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      env: {
        hasGemini: !!process.env.GEMINI_API_KEY,
        hasNotion: !!process.env.NOTION_API_KEY,
        hasPageId: !!process.env.NOTION_PAGE_ID,
        nodeEnv: process.env.NODE_ENV,
        isVercel: !!process.env.VERCEL,
        isNetlify: !!process.env.NETLIFY
      }
    });
  });

  app.get("/api/metrics", (req, res) => {
    const authHeader = String(req.headers.authorization || "");
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const token = String(req.query.token || bearer || "").trim();
    const isProduction = process.env.NODE_ENV === "production";

    if (isProduction && METRICS_TOKEN && token !== METRICS_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    return res.json({
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - runtimeMetrics.startedAt) / 1000),
      config: {
        requestWindowMs: REQUEST_WINDOW_MS,
        maxRequestsPerWindow: MAX_REQUESTS_PER_WINDOW,
        cacheTtlMs: CACHE_TTL_MS,
        quotaCooldownMs: HARD_QUOTA_COOLDOWN_MS,
        fallbackEnabled: ENABLE_HARD_QUOTA_FALLBACK
      },
      counters: {
        ...runtimeMetrics,
        activeRateLimitBuckets: requestCounters.size,
        activeCacheEntries: responseCache.size
      }
    });
  });

  // API Routes
  app.post("/api/chat", async (req, res) => {
    cleanupInMemoryMaps();
    runtimeMetrics.requestsTotal += 1;
    const startTime = Date.now();
    console.time("ChatRequest");
    const normalizedMessages = normalizeMessages(req.body?.messages || []);

    console.log(`[Chat API] Received request with ${normalizedMessages.length || 0} messages`);

    if (!Array.isArray(req.body?.messages)) {
      return res.status(400).json({ error: "Messages array is required" });
    }

    if (normalizedMessages.length === 0) {
      return res.status(400).json({ error: "At least one non-empty message is required" });
    }

    const ip = getClientIp(req);
    const ipRateLimit = getRateLimitDecision(ip);
    if (!ipRateLimit.allowed) {
      runtimeMetrics.clientRateLimited += 1;
      runtimeMetrics.requestsFailed += 1;
      res.setHeader("Retry-After", String(ipRateLimit.retryAfterSeconds));
      return res.status(429).json({
        error: "Too many requests from this client. Please retry shortly.",
        code: "client_rate_limited",
        retryAfterSeconds: ipRateLimit.retryAfterSeconds
      });
    }

    try {
      const now = Date.now();
      if (quotaCooldownUntil > now) {
        const retryAfterSeconds = getQuotaRetryAfterSeconds(now);
        runtimeMetrics.geminiHardQuota += 1;
        if (ENABLE_HARD_QUOTA_FALLBACK) {
          runtimeMetrics.fallbackResponses += 1;
          runtimeMetrics.requestsSucceeded += 1;
          return res.json({
            content: buildHardQuotaFallbackText(normalizedMessages[normalizedMessages.length - 1].content, retryAfterSeconds),
            degraded: true,
            code: "fallback_mode",
            retryAfterSeconds
          });
        }
        runtimeMetrics.requestsFailed += 1;
        res.setHeader("Retry-After", String(retryAfterSeconds));
        return res.status(429).json({
          error: "Gemini quota is currently exhausted for this key. Please retry later or switch to a key with available free quota.",
          code: "hard_quota",
          retryAfterSeconds
        });
      }

      const geminiApiKey = (
        process.env.GEMINI_API_KEY || 
        process.env.API_KEY || 
        ""
      ).trim().replace(/^["']|["']$/g, ""); // Remove potential quotes
      
      const notionApiKey = (process.env.NOTION_API_KEY || "").trim().replace(/^["']|["']$/g, "");
      const notionPageId = (process.env.NOTION_PAGE_ID || "").trim().replace(/^["']|["']$/g, "");

      console.log(`[Chat API] Key Check: Gemini=${!!geminiApiKey}, Notion=${!!notionApiKey}, PageId=${!!notionPageId}`);
      if (geminiApiKey) console.log(`[Chat API] Gemini Key starts with: ${geminiApiKey.substring(0, 5)}...`);

      if (!geminiApiKey) console.error("[Chat API] GEMINI_API_KEY is missing!");
      if (!notionApiKey) console.error("[Chat API] NOTION_API_KEY is missing!");
      if (!notionPageId) console.error("[Chat API] NOTION_PAGE_ID is missing!");

      if (!geminiApiKey || !notionApiKey || !notionPageId) {
        console.error(`[Chat API] Missing keys: Gemini=${!!geminiApiKey}, Notion=${!!notionApiKey}, PageId=${!!notionPageId}`);
        runtimeMetrics.requestsFailed += 1;
        return res.status(500).json({ 
          error: "Missing API keys. Please ensure GEMINI_API_KEY, NOTION_API_KEY, and NOTION_PAGE_ID are set in your environment variables.",
          debug: {
            hasGemini: !!geminiApiKey,
            hasNotion: !!notionApiKey,
            hasPageId: !!notionPageId
          }
        });
      }

      const ai = new GoogleGenAI({ apiKey: geminiApiKey });
      const notion = new Client({ auth: notionApiKey });

      const isBudgetMode = process.env.GEMINI_BUDGET_MODE !== "false";
      const enableWebSearch = process.env.ENABLE_WEB_SEARCH === "true" && !isBudgetMode;
      const enableImageGeneration = process.env.ENABLE_IMAGE_GENERATION === "true" && !isBudgetMode;

      const functionDeclarations: any[] = [
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
              description: "Retrieve the content blocks of a Notion page. Use this to find block IDs for deletion.",
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
              description: "List rows from a Notion database with optional filtering and sorting.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  database_id: { type: Type.STRING, description: "The ID of the database." },
                  filter: { type: Type.OBJECT, description: "Optional filter (e.g., { property: 'Status', select: { equals: 'Done' } })" },
                  sorts: { type: Type.ARRAY, items: { type: Type.OBJECT }, description: "Optional sorts (e.g., [{ property: 'Date', direction: 'ascending' }])" }
                },
                required: ["database_id"]
              }
            },
            {
              name: "get_multiple_pages_content",
              description: "Retrieve the content of multiple Notion pages at once for cross-page analysis.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  page_ids: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Array of page IDs to fetch." }
                },
                required: ["page_ids"]
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
              name: "delete_block",
              description: "Delete a specific block (text, image, etc.) from a page.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  block_id: { type: Type.STRING, description: "The ID of the block to delete." }
                },
                required: ["block_id"]
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
      ];

      const tools: any[] = [
        {
          functionDeclarations: enableImageGeneration
            ? functionDeclarations
            : functionDeclarations.filter(t => t.name !== "generate_image")
        }
      ];

      if (enableWebSearch) {
        tools.push({ googleSearch: {} });
      }

      // Optimize history: only keep recent messages to reduce token overhead and speed up processing
      const lastMessage = normalizedMessages[normalizedMessages.length - 1].content;
      const historyLimit = isBudgetMode ? 3 : 6;
      const recentMessages = normalizedMessages.slice(-historyLimit - 1, -1);

      const canUseResponseCache = !isLikelyMutatingPrompt(lastMessage);
      const cacheKey = canUseResponseCache ? buildCacheKey(normalizedMessages, notionPageId) : "";
      if (canUseResponseCache && cacheKey) {
        const cached = responseCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          console.log("[Chat API] Served cached response for read-only request");
          runtimeMetrics.cacheHits += 1;
          runtimeMetrics.requestsSucceeded += 1;
          return res.json({ content: cached.content, cached: true });
        }
      }
      
      const history = recentMessages.map(m => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.content }]
      }));

      const systemInstruction = `You are Notion AI, the ultimate workspace assistant.
      Your capabilities include:
      1. **Database Management**: Create databases automatically, add/update rows, query with filters, and sort results.
      2. **Page Operations**: Create/delete pages, add/delete specific text blocks.
      3. **Rich Content Support**: You MUST use these block types when creating/updating content:
         - 'heading_1', 'heading_2', 'heading_3'
         - 'bulleted_list_item', 'numbered_list_item'
         - 'to_do' (checklists)
         - 'toggle' (toggle lists)
         - 'code' (code blocks)
         - 'table' (tables)
         - 'callout', 'quote'
      4. **Content Transformation**: 
         - Summarize long pages or meeting notes.
         - Extract key ideas into bullet points.
         - Convert notes into action items (checklists).
         - Convert unstructured text into structured databases.
      5. **Research & Inference**: Use 'googleSearch' for real-time research. Generate summaries and inferences from workspace data.
      6. **Representations**: Generate structured data for graphs or visual representations when requested. 
         - For charts, output a JSON block like: \`\`\`json { "type": "bar", "title": "Tasks by Status", "data": [{ "name": "Done", "value": 5 }, { "name": "In Progress", "value": 3 }] } \`\`\`
         - For knowledge base entries, output: \`\`\`json { "knowledge_base": [{ "title": "Project Summary", "summary": "..." }] } \`\`\`

      Guidelines:
      - parent_id: ${notionPageId}
      - Be professional, highly efficient, and proactive.
      - When summarizing, be concise but thorough.
      - For "action items", use 'to_do' blocks.
      - For "key ideas", use 'bulleted_list_item' or 'callout' blocks.
      - If a user asks for a "graph", provide the JSON representation as shown above.
      - Always confirm successful operations with a brief summary.
      - If you hit a quota error, apologize and suggest the user wait a few seconds before retrying.`;

      // Fast-path for simple greetings or short messages (less than 20 chars)
      const isSimpleMessage = lastMessage.length < 20 && 
        !lastMessage.toLowerCase().includes("notion") && 
        !lastMessage.toLowerCase().includes("page") &&
        !lastMessage.toLowerCase().includes("create") &&
        !lastMessage.toLowerCase().includes("update");

      if (isSimpleMessage) {
        const fastResponse = await retryGenerateContent(ai, {
          model: "gemini-3.1-flash-lite-preview",
          contents: [{ role: "user", parts: [{ text: lastMessage }] }],
          config: {
            systemInstruction: "Briefly respond to greetings or short chat.",
            maxOutputTokens: isBudgetMode ? 120 : 220,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }
          },
        });
        if (canUseResponseCache && cacheKey) {
          responseCache.set(cacheKey, {
            content: fastResponse.text || "Hello! How can I help you with Notion today?",
            expiresAt: Date.now() + CACHE_TTL_MS
          });
          runtimeMetrics.cacheWrites += 1;
        }
        runtimeMetrics.requestsSucceeded += 1;
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
      const MAX_TURNS = isBudgetMode ? 1 : ((process.env.VERCEL || process.env.NETLIFY) ? 2 : 5);

      while (turnCount < MAX_TURNS) {
        console.log(`[Chat API] Starting turn ${turnCount + 1}/${MAX_TURNS}`);
        console.time(`Turn ${turnCount + 1}`);
        const response = await retryGenerateContent(ai, {
          model: (process.env.NETLIFY || process.env.VERCEL) ? "gemini-3.1-flash-lite-preview" : "gemini-3-flash-preview",
          contents: currentHistory,
          config: {
            systemInstruction,
            tools: tools,
            maxOutputTokens: isBudgetMode ? 220 : 500,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }
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
          runtimeMetrics.toolCalls += 1;
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
              case "get_multiple_pages_content":
                const pageIds = args.page_ids as string[];
                const pageContents = await Promise.all(pageIds.map(async (id) => {
                  try {
                    const blocks = await notion.blocks.children.list({ block_id: id });
                    return { page_id: id, content: blocks.results };
                  } catch (e) {
                    return { page_id: id, error: "Failed to fetch content" };
                  }
                }));
                result = pageContents;
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
              case "delete_block":
                result = await notion.blocks.delete({
                  block_id: args.block_id as string
                });
                break;
              case "generate_image":
                const imgResponse = await retryGenerateContent(ai, {
                  model: "gemini-2.5-flash-image",
                  contents: [{ role: "user", parts: [{ text: args.prompt as string }] }]
                });
                let base64Image = "";
                if (imgResponse.candidates?.[0]?.content?.parts) {
                  for (const part of imgResponse.candidates[0].content.parts) {
                    if (part.inlineData) {
                      base64Image = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
                      break;
                    }
                  }
                }
                result = { imageUrl: base64Image || "Failed to generate image" };
                break;
              default:
                result = { error: "Unknown tool" };
            }
            return { name, result, id };
          } catch (err: any) {
            runtimeMetrics.toolCallFailures += 1;
            console.error(`[Chat API] Tool error (${name}):`, err);
            // Include more details in the tool response so the AI can understand what went wrong
            return { 
              name, 
              result: { 
                error: err.message,
                code: err.code,
                status: err.status
              }, 
              id 
            };
          }
        }));

        // Add model's call and tool's response to history
        currentHistory.push({ role: "model", parts: response.candidates[0].content.parts as any });
        currentHistory.push({ 
          role: "user", 
          parts: toolResults.map(r => ({ 
            functionResponse: {
              name: r.name,
              response: r.result,
              id: r.id
            }
          })) as any
        });

        turnCount++;

        // Optimization for serverless: If we just finished the first turn and it included tools,
        // and we are on a platform with tight timeouts, return a manual summary instead of another AI call.
        if (turnCount === 1 && (process.env.NETLIFY || process.env.VERCEL) && functionCalls.length > 0) {
          console.log("[Chat API] Serverless optimization: Returning manual summary after tool execution");
          const summary = toolResults.map(r => {
            const toolName = r.name.replace(/_/g, ' ');
            if (r.result?.error) return `❌ Failed to ${toolName}: ${r.result.error}`;
            return `✅ Successfully executed: ${toolName}`;
          }).join('\n');
          finalResponseText = "I've processed your request:\n\n" + summary + "\n\n(Note: Summary generated automatically to prevent timeout)";
          break;
        }
      }

      // If we exited the loop due to MAX_TURNS, get a final summary
      if (turnCount === MAX_TURNS && !finalResponseText) {
        const finalResponse = await retryGenerateContent(ai, {
          model: isBudgetMode ? "gemini-3.1-flash-lite-preview" : "gemini-3-flash-preview",
          contents: currentHistory,
          config: {
            systemInstruction: "You have reached the maximum number of turns. Please provide a final summary of what you have accomplished so far and any errors encountered.",
            maxOutputTokens: isBudgetMode ? 220 : 500,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }
          },
        });
        finalResponseText = finalResponse.text || "I've reached the maximum number of steps for this task. Please check your Notion workspace for the results.";
      }

      // Final cleanup and timing - Removed artificial delay for serverless compatibility
      const totalTime = Date.now() - startTime;
      console.timeEnd("ChatRequest");
      console.log(`[Chat API] Request completed in ${totalTime}ms`);
      if (canUseResponseCache && cacheKey && finalResponseText) {
        responseCache.set(cacheKey, {
          content: finalResponseText,
          expiresAt: Date.now() + CACHE_TTL_MS
        });
        runtimeMetrics.cacheWrites += 1;
      }
      runtimeMetrics.requestsSucceeded += 1;
      res.json({ content: finalResponseText || "I've completed the requested actions in your Notion workspace." });

    } catch (error: any) {
      console.timeEnd("ChatRequest");
      console.error("[Chat API] Agentic Error:", error);
      const geminiError = classifyGeminiError(error);
      const isQuotaStyleError = geminiError.kind === "hard_quota" || geminiError.kind === "rate_limited";

      if (isQuotaStyleError) {
        if (geminiError.kind === "hard_quota") {
          quotaCooldownUntil = Date.now() + HARD_QUOTA_COOLDOWN_MS;
          runtimeMetrics.geminiHardQuota += 1;
        } else {
          runtimeMetrics.geminiRateLimited += 1;
        }

        const retryAfterSeconds = geminiError.kind === "hard_quota"
          ? getQuotaRetryAfterSeconds()
          : 20;

        if (geminiError.kind === "hard_quota" && ENABLE_HARD_QUOTA_FALLBACK) {
          runtimeMetrics.fallbackResponses += 1;
          runtimeMetrics.requestsSucceeded += 1;
          return res.json({
            content: buildHardQuotaFallbackText(normalizedMessages[normalizedMessages.length - 1].content, retryAfterSeconds),
            degraded: true,
            code: "fallback_mode",
            retryAfterSeconds
          });
        }

        const responseBody = geminiError.kind === "hard_quota"
          ? {
              error: "Gemini API quota exhausted for this project key. Add billing or increase quota in Google AI Studio, then retry.",
              code: "hard_quota",
              retryAfterSeconds
            }
          : {
              error: "Gemini is temporarily rate-limited. Please retry shortly.",
              code: "rate_limited",
              retryAfterSeconds
            };

        res.setHeader("Retry-After", String(responseBody.retryAfterSeconds));
        runtimeMetrics.requestsFailed += 1;
        return res.status(429).json(responseBody);
      }
      
      // Log more details for debugging
      const errorDetails = {
        message: getErrorMessage(error) || error.message,
        stack: error.stack,
        env: {
          hasGemini: !!process.env.GEMINI_API_KEY,
          hasNotion: !!process.env.NOTION_API_KEY,
          hasPageId: !!process.env.NOTION_PAGE_ID,
          nodeEnv: process.env.NODE_ENV,
          isVercel: !!process.env.VERCEL,
          isNetlify: !!process.env.NETLIFY
        }
      };
      console.error("[Chat API] Error Details:", JSON.stringify(errorDetails, null, 2));

      runtimeMetrics.requestsFailed += 1;
      res.status(500).json({ 
        error: getErrorMessage(error) || "An unexpected error occurred in the workspace assistant.",
        debug: process.env.NODE_ENV !== "production" ? errorDetails : undefined
      });
    }
  });

  // Global error handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Express Global Error:", err);
    res.status(500).json({ 
      error: "Internal Server Error", 
      details: err.message,
      stack: process.env.NODE_ENV !== "production" ? err.stack : undefined
    });
  });

  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL && !process.env.NETLIFY) {
    try {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (e) {
      console.warn("Vite not found or failed to load, skipping Vite middleware.");
    }
  } else if (!process.env.NETLIFY && !process.env.VERCEL) {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  return app;
}

// Export for serverless environments (Vercel)
export default createServer;

// Start server if running directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("server.ts") || 
  process.argv[1].endsWith("server.js") || 
  process.argv[1].includes("node_modules/.bin/tsx")
);

if (isMain && !process.env.NETLIFY && !process.env.VERCEL) {
  createServer().then(app => {
    // Port 3000 is hardcoded by the infrastructure
    const PORT = 3000;
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }).catch(err => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
