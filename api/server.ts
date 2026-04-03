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

function getPlainTextFromRichTextArray(richText: any[] | undefined): string {
  if (!Array.isArray(richText)) return "";
  return richText
    .map((item: any) => item?.plain_text || item?.text?.content || "")
    .join("")
    .trim();
}

function extractPageTitle(result: any): string {
  if (!result || result.object !== "page") return "";
  const propMap = result.properties || {};
  for (const key of Object.keys(propMap)) {
    const prop = propMap[key];
    if (prop?.type === "title") {
      return getPlainTextFromRichTextArray(prop.title);
    }
  }
  return "";
}

async function findPageByReference(notion: Client, reference: string): Promise<{ id: string; title: string } | null> {
  const cleaned = reference.replace(/^@/, "").trim();
  if (!cleaned) return null;

  const result = await notion.search({
    query: cleaned,
    filter: { value: "page", property: "object" } as any,
    page_size: 20
  });

  const pages = (result.results || [])
    .filter((r: any) => r.object === "page")
    .map((r: any) => ({ id: r.id as string, title: extractPageTitle(r) }))
    .filter((r: any) => r.id);

  if (pages.length === 0) return null;

  const exact = pages.find((p: any) => p.title.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact;

  const partial = pages.find((p: any) => p.title.toLowerCase().includes(cleaned.toLowerCase()));
  if (partial) return partial;

  return pages[0];
}

async function resolvePageId(
  notion: Client,
  args: any,
  defaultPageId: string
): Promise<{ pageId: string; resolvedTitle?: string }> {
  if (args?.page_id && String(args.page_id).trim().length > 0) {
    return { pageId: String(args.page_id).trim() };
  }

  const candidateRef = String(args?.page_reference || args?.page_name || "").trim();
  if (candidateRef) {
    const page = await findPageByReference(notion, candidateRef);
    if (page) return { pageId: page.id, resolvedTitle: page.title };
    throw new Error(`Could not find a Notion page matching reference: ${candidateRef}`);
  }

  return { pageId: defaultPageId };
}

function isActionIntent(prompt: string): boolean {
  return /(create|add|append|insert|update|edit|modify|delete|remove|archive|extract|summari[sz]e|research|search|find|database|table|page|notion)/i.test(prompt);
}

function toRichText(content: string) {
  return [{ type: "text", text: { content: content.slice(0, 1900) } }];
}

function buildPlainTextBlocks(text: string, style: string = "paragraph"): any[] {
  const normalizedStyle = String(style || "paragraph").toLowerCase();
  const chunks = text
    .split(/\n{2,}/)
    .map(t => t.trim())
    .filter(Boolean)
    .slice(0, 80);

  const safeChunks = chunks.length > 0 ? chunks : [text.trim()].filter(Boolean);

  return safeChunks.map(chunk => {
    const richText = toRichText(chunk);
    switch (normalizedStyle) {
      case "heading_1":
        return { object: "block", type: "heading_1", heading_1: { rich_text: richText } };
      case "heading_2":
        return { object: "block", type: "heading_2", heading_2: { rich_text: richText } };
      case "heading_3":
        return { object: "block", type: "heading_3", heading_3: { rich_text: richText } };
      case "bulleted_list_item":
        return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText } };
      case "numbered_list_item":
        return { object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: richText } };
      case "to_do":
        return { object: "block", type: "to_do", to_do: { rich_text: richText, checked: false } };
      case "quote":
        return { object: "block", type: "quote", quote: { rich_text: richText } };
      case "code":
        return { object: "block", type: "code", code: { rich_text: richText, language: "plain text" } };
      case "callout":
        return { object: "block", type: "callout", callout: { rich_text: richText, icon: { emoji: "💡" } } };
      case "toggle":
        return { object: "block", type: "toggle", toggle: { rich_text: richText } };
      default:
        return { object: "block", type: "paragraph", paragraph: { rich_text: richText } };
    }
  });
}

async function tryHandleDirectAction(lastMessage: string, notion: Client, notionPageId: string): Promise<string | null> {
  const addToThisPageMatch = lastMessage.match(/(?:add|append|insert)\s+([\s\S]+?)\s+(?:to|into|in)\s+(?:this\s+)?page[.!?\s]*$/i);
  if (addToThisPageMatch?.[1]) {
    const text = addToThisPageMatch[1].trim();
    if (text.length > 0) {
      await notion.blocks.children.append({
        block_id: notionPageId,
        children: buildPlainTextBlocks(text, "paragraph") as any
      });
      return "Done. I added your text to the current Notion page.";
    }
  }

  const addToNamedPageMatch = lastMessage.match(/(?:add|append|insert)\s+([\s\S]+?)\s+(?:to|into|in)\s+@?([\w\s\-_/]+)[.!?\s]*$/i);
  if (addToNamedPageMatch?.[1] && addToNamedPageMatch?.[2]) {
    const text = addToNamedPageMatch[1].trim();
    const pageRef = addToNamedPageMatch[2].trim();
    if (text.length > 0 && pageRef.length > 0 && !/^(this\s+page)$/i.test(pageRef)) {
      const page = await findPageByReference(notion, pageRef);
      if (page) {
        await notion.blocks.children.append({
          block_id: page.id,
          children: buildPlainTextBlocks(text, "paragraph") as any
        });
        return `Done. I added your text to \"${page.title || pageRef}\".`;
      }
    }
  }

  const createPageWithTextMatch = lastMessage.match(/create\s+(?:a\s+)?page\s+(?:called|named|title[d]?)\s+["“]?(.+?)["”]?(?:\s+with\s+([\s\S]+))?$/i);
  if (createPageWithTextMatch?.[1]) {
    const title = createPageWithTextMatch[1].trim();
    const body = (createPageWithTextMatch[2] || "").trim();
    const children = body ? buildPlainTextBlocks(body, "paragraph") : [];
    await notion.pages.create({
      parent: { page_id: notionPageId },
      properties: { title: { title: [{ text: { content: title.slice(0, 180) } }] } } as any,
      children: children as any
    });
    return body
      ? `Done. I created the page \"${title}\" and added your text content.`
      : `Done. I created the page \"${title}\".`;
  }

  const createInNamedPageMatch = lastMessage.match(/create\s+(?:a\s+)?page\s+(?:called|named)\s+["“]?(.+?)["”]?\s+(?:in|under)\s+@?([\w\s\-_/]+)(?:\s+with\s+([\s\S]+))?$/i);
  if (createInNamedPageMatch?.[1] && createInNamedPageMatch?.[2]) {
    const title = createInNamedPageMatch[1].trim();
    const parentRef = createInNamedPageMatch[2].trim();
    const body = (createInNamedPageMatch[3] || "").trim();
    const parentPage = await findPageByReference(notion, parentRef);
    if (parentPage) {
      await notion.pages.create({
        parent: { page_id: parentPage.id },
        properties: { title: { title: [{ text: { content: title.slice(0, 180) } }] } } as any,
        children: body ? (buildPlainTextBlocks(body, "paragraph") as any) : undefined
      });
      return `Done. I created \"${title}\" under \"${parentPage.title || parentRef}\".`;
    }
  }

  return null;
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

function getBlockText(block: any): string {
  if (!block || !block.type) return "";
  const payload = block[block.type];
  if (!payload) return "";
  if (payload.rich_text) return getPlainTextFromRichTextArray(payload.rich_text);
  return "";
}

async function listPageText(notion: Client, pageId: string): Promise<string> {
  const response = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
  const lines = (response.results || [])
    .map((block: any) => getBlockText(block))
    .filter((line: string) => line && line.trim().length > 0)
    .slice(0, 120);
  return lines.join("\n");
}

function extractQueryTerms(prompt: string): string[] {
  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "into", "from", "your", "page", "notion",
    "create", "update", "delete", "add", "append", "make", "need", "please", "about", "what"
  ]);

  const words = String(prompt || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 4 && !stopWords.has(w));

  return Array.from(new Set(words)).slice(0, 6);
}

async function buildWorkspaceContext(
  notion: Client,
  prompt: string,
  defaultPageId: string,
  maxPages: number
): Promise<string> {
  const terms = extractQueryTerms(prompt);
  const query = terms.length > 0 ? terms.join(" ") : String(prompt || "").slice(0, 60);
  if (!query.trim()) return "";

  const search = await notion.search({
    query,
    filter: { value: "page", property: "object" } as any,
    page_size: Math.max(2, Math.min(maxPages, 6))
  });

  const pages = (search.results || [])
    .filter((r: any) => r.object === "page")
    .slice(0, maxPages)
    .map((r: any) => ({ id: r.id as string, title: extractPageTitle(r) || "Untitled" }));

  if (pages.length === 0) {
    const fallbackText = await listPageText(notion, defaultPageId).catch(() => "");
    return fallbackText ? `Root page context:\n${cleanModelText(fallbackText, 1600)}` : "";
  }

  const snippets: string[] = [];
  for (const p of pages) {
    const txt = await listPageText(notion, p.id).catch(() => "");
    if (txt) {
      snippets.push(`Page: ${p.title} (id: ${p.id})\n${cleanModelText(txt, 1400)}`);
    }
  }

  return snippets.join("\n\n---\n\n");
}

function buildDatabaseTemplateProperties(templateType: string): Record<string, any> {
  const kind = String(templateType || "task_tracker").toLowerCase();

  if (kind === "meeting_notes") {
    return {
      Name: { title: {} },
      Date: { date: {} },
      Owner: { rich_text: {} },
      Attendees: { multi_select: {} },
      Summary: { rich_text: {} },
      "Action Items": { rich_text: {} },
      Status: { select: { options: [{ name: "Draft" }, { name: "Reviewed" }, { name: "Done" }] } }
    };
  }

  if (kind === "content_calendar") {
    return {
      Title: { title: {} },
      Platform: { select: { options: [{ name: "LinkedIn" }, { name: "X" }, { name: "Instagram" }, { name: "YouTube" }, { name: "Blog" }] } },
      "Publish Date": { date: {} },
      Owner: { rich_text: {} },
      Status: { select: { options: [{ name: "Idea" }, { name: "Draft" }, { name: "Scheduled" }, { name: "Published" }] } },
      Campaign: { rich_text: {} }
    };
  }

  if (kind === "crm") {
    return {
      Name: { title: {} },
      Company: { rich_text: {} },
      Stage: { select: { options: [{ name: "Lead" }, { name: "Qualified" }, { name: "Proposal" }, { name: "Won" }, { name: "Lost" }] } },
      Value: { number: { format: "dollar" } },
      Owner: { rich_text: {} },
      "Next Follow-up": { date: {} }
    };
  }

  return {
    Name: { title: {} },
    Status: { select: { options: [{ name: "To Do" }, { name: "In Progress" }, { name: "Blocked" }, { name: "Done" }] } },
    Priority: { select: { options: [{ name: "Low" }, { name: "Medium" }, { name: "High" }, { name: "Urgent" }] } },
    "Due Date": { date: {} },
    Owner: { rich_text: {} },
    Notes: { rich_text: {} }
  };
}

function cleanModelText(text: string, maxLen = 18000): string {
  return String(text || "").replace(/\u0000/g, "").trim().slice(0, maxLen);
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
    const agentMode = String(req.body?.agentMode || "standard").toLowerCase();
    const isCompleteAiMode = agentMode === "complete" || agentMode === "deep" || agentMode === "notion_ai";

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
                  page_reference: { type: Type.STRING, description: "Optional page title reference (for example @Project Notes)." },
                  content_blocks: { type: Type.ARRAY, items: { type: Type.OBJECT }, description: "Blocks to append." }
                },
                required: ["content_blocks"]
              }
            },
            {
              name: "get_page_content",
              description: "Retrieve the content blocks of a Notion page. Use this to find block IDs for deletion.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  page_id: { type: Type.STRING, description: "The ID of the page." },
                  page_reference: { type: Type.STRING, description: "Optional page title reference." }
                },
                required: []
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
                  page_id: { type: Type.STRING, description: "The ID of the page to archive." },
                  page_reference: { type: Type.STRING, description: "Optional page title reference." }
                },
                required: []
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
            },
            {
              name: "create_page_with_text",
              description: "Create a new Notion page from plain text without requiring block JSON.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: "Title for the new page." },
                  text: { type: Type.STRING, description: "Main text content to add to the page." },
                  style: {
                    type: Type.STRING,
                    description: "Optional block style: paragraph, heading_1, heading_2, heading_3, bulleted_list_item, numbered_list_item, to_do, quote, callout, code, toggle"
                  },
                  parent_id: { type: Type.STRING, description: "Optional parent page id. Defaults to root page." }
                },
                required: ["title", "text"]
              }
            },
            {
              name: "append_text_to_page",
              description: "Append plain text to a Notion page without requiring block JSON.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  page_id: { type: Type.STRING, description: "Optional target page id. Defaults to root page." },
                  page_reference: { type: Type.STRING, description: "Optional page title reference (for example @Team Updates)." },
                  text: { type: Type.STRING, description: "Text content to append." },
                  style: {
                    type: Type.STRING,
                    description: "Optional block style: paragraph, heading_1, heading_2, heading_3, bulleted_list_item, numbered_list_item, to_do, quote, callout, code, toggle"
                  }
                },
                required: ["text"]
              }
            },
            {
              name: "extract_action_items_from_page",
              description: "Extract action items from a page and optionally write them back as to-do blocks.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  page_id: { type: Type.STRING, description: "Optional page ID." },
                  page_reference: { type: Type.STRING, description: "Optional page title reference." },
                  target_page_id: { type: Type.STRING, description: "Optional page ID where extracted tasks should be written." },
                  write_back: { type: Type.BOOLEAN, description: "If true, append extracted items as to-do blocks to target page." }
                },
                required: []
              }
            },
            {
              name: "summarize_page_content",
              description: "Create a concise summary of a Notion page and optionally append it back to a target page.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  page_id: { type: Type.STRING, description: "Optional page ID." },
                  page_reference: { type: Type.STRING, description: "Optional page title reference." },
                  max_points: { type: Type.INTEGER, description: "Maximum bullet points in summary (default 6)." },
                  append_to_page_id: { type: Type.STRING, description: "Optional target page for writing summary." }
                },
                required: []
              }
            },
            {
              name: "create_smart_database",
              description: "Create a Notion database from a built-in AI template (task tracker, meeting notes, content calendar, crm).",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: "Database title." },
                  template_type: { type: Type.STRING, description: "One of: task_tracker, meeting_notes, content_calendar, crm" },
                  parent_id: { type: Type.STRING, description: "Optional parent page id." },
                  parent_reference: { type: Type.STRING, description: "Optional parent page title reference, e.g. @Team Hub." }
                },
                required: ["title", "template_type"]
              }
            },
            {
              name: "rewrite_page_content",
              description: "Rewrite a page with a target tone/style and optionally append rewritten output to another page.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  page_id: { type: Type.STRING, description: "Optional source page id." },
                  page_reference: { type: Type.STRING, description: "Optional source page title reference." },
                  objective: { type: Type.STRING, description: "Rewrite objective, e.g. make concise, executive summary, persuasive, formal." },
                  tone: { type: Type.STRING, description: "Optional tone such as professional, friendly, technical." },
                  format: { type: Type.STRING, description: "Optional output format such as bullets, memo, email, checklist." },
                  append_to_page_id: { type: Type.STRING, description: "Optional target page id to append rewritten output." }
                },
                required: ["objective"]
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
      const historyLimit = isCompleteAiMode ? (isBudgetMode ? 6 : 10) : (isBudgetMode ? 3 : 6);
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

      const workspaceContext = isCompleteAiMode
        ? await buildWorkspaceContext(notion, lastMessage, notionPageId, isBudgetMode ? 2 : 4)
        : "";

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
      - ACTION EXECUTION RULE: If the user asks to create/update/delete/add/extract/search/research in Notion, you MUST execute by calling tools. Do not only describe or promise actions.
      - For plain text content requests, prefer create_page_with_text or append_text_to_page before using advanced block JSON.
      - If page/database id is missing, call search_notion first, then perform the requested action.
      - When summarizing, be concise but thorough.
      - For "action items", use 'to_do' blocks.
      - For "key ideas", use 'bulleted_list_item' or 'callout' blocks.
      - If a user asks for a "graph", provide the JSON representation as shown above.
      - Always confirm successful operations with a brief summary.
      - If you hit a quota error, apologize and suggest the user wait a few seconds before retrying.
      - If workspace context is provided, ground your answer in it and mention relevant page titles used.

      Workspace context (may be partial):
      ${workspaceContext || "No extra context retrieved."}`;

      const directActionResult = await tryHandleDirectAction(lastMessage, notion, notionPageId);
      if (directActionResult) {
        runtimeMetrics.requestsSucceeded += 1;
        return res.json({ content: directActionResult, executedDirectAction: true });
      }

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
      const requiresActionExecution = isActionIntent(lastMessage);
      const baseMaxTurns = isCompleteAiMode
        ? (isBudgetMode ? 2 : ((process.env.VERCEL || process.env.NETLIFY) ? 3 : 6))
        : (isBudgetMode ? 1 : ((process.env.VERCEL || process.env.NETLIFY) ? 2 : 5));
      const MAX_TURNS = requiresActionExecution ? Math.max(baseMaxTurns, 2) : baseMaxTurns;
      let forcedToolCallAttempted = false;
      let latestToolSummaryText = "";

      while (turnCount < MAX_TURNS) {
        console.log(`[Chat API] Starting turn ${turnCount + 1}/${MAX_TURNS}`);
        console.time(`Turn ${turnCount + 1}`);
        const response = await retryGenerateContent(ai, {
          model: (process.env.NETLIFY || process.env.VERCEL) ? "gemini-3.1-flash-lite-preview" : "gemini-3-flash-preview",
          contents: currentHistory,
          config: {
            systemInstruction,
            tools: tools,
            maxOutputTokens: isCompleteAiMode ? (isBudgetMode ? 320 : 700) : (isBudgetMode ? 220 : 500),
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }
          },
        });
        console.timeEnd(`Turn ${turnCount + 1}`);

        const functionCalls = response.functionCalls;
        
        if (!functionCalls || functionCalls.length === 0) {
          if (requiresActionExecution && !forcedToolCallAttempted) {
            forcedToolCallAttempted = true;
            currentHistory.push({
              role: "user",
              parts: [{
                text: "Execution reminder: The user asked for a Notion action. You must call one or more tools now. If you need identifiers, call search_notion first."
              }]
            } as any);
            turnCount++;
            continue;
          }
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
                const updateTarget = await resolvePageId(notion, args, notionPageId);
                result = await notion.blocks.children.append({
                  block_id: updateTarget.pageId,
                  children: args.content_blocks as any
                });
                break;
              case "get_page_content":
                const readTarget = await resolvePageId(notion, args, notionPageId);
                result = await notion.blocks.children.list({ block_id: readTarget.pageId });
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
                const archiveTarget = await resolvePageId(notion, args, notionPageId);
                result = await notion.pages.update({
                  page_id: archiveTarget.pageId,
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
              case "create_page_with_text":
                result = await notion.pages.create({
                  parent: { page_id: (args.parent_id as string) || notionPageId },
                  properties: { title: { title: [{ text: { content: String(args.title || "Untitled").slice(0, 180) } }] } } as any,
                  children: buildPlainTextBlocks(String(args.text || ""), String(args.style || "paragraph")) as any
                });
                break;
              case "append_text_to_page":
                const appendTarget = await resolvePageId(notion, args, notionPageId);
                result = await notion.blocks.children.append({
                  block_id: appendTarget.pageId,
                  children: buildPlainTextBlocks(String(args.text || ""), String(args.style || "paragraph")) as any
                });
                break;
              case "extract_action_items_from_page":
                const extractTarget = await resolvePageId(notion, args, notionPageId);
                const extractText = await listPageText(notion, extractTarget.pageId);
                const actionRegex = /(?:^-\s*\[\s?\]|^-\s+|^\d+\.\s+|\b(todo|action item|next step|follow up)\b[:\-]?\s*)(.+)$/gim;
                const extracted: string[] = [];
                let match: RegExpExecArray | null;
                while ((match = actionRegex.exec(extractText)) !== null) {
                  const line = String(match[2] || "").trim();
                  if (line.length > 0 && !extracted.includes(line)) extracted.push(line);
                }
                const tasks = extracted.slice(0, 20);
                if ((args.write_back === true) && tasks.length > 0) {
                  const writeTarget = String(args.target_page_id || extractTarget.pageId);
                  await notion.blocks.children.append({
                    block_id: writeTarget,
                    children: tasks.map(item => ({
                      object: "block",
                      type: "to_do",
                      to_do: { rich_text: toRichText(item), checked: false }
                    })) as any
                  });
                }
                result = {
                  sourcePageId: extractTarget.pageId,
                  extractedCount: tasks.length,
                  tasks,
                  wroteBack: args.write_back === true
                };
                break;
              case "summarize_page_content":
                const summaryTarget = await resolvePageId(notion, args, notionPageId);
                const sourceText = await listPageText(notion, summaryTarget.pageId);
                const maxPoints = Math.min(12, Math.max(3, Number(args.max_points || 6)));
                const summaryResponse = await retryGenerateContent(ai, {
                  model: "gemini-3.1-flash-lite-preview",
                  contents: [{ role: "user", parts: [{ text: `Summarize this Notion page text into ${maxPoints} concise bullet points:\n\n${sourceText.slice(0, 14000)}` }] }],
                  config: {
                    systemInstruction: "Return only concise bullet points. No markdown title.",
                    maxOutputTokens: 280,
                    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }
                  }
                });
                const summaryText = String(summaryResponse.text || "").trim();
                if (args.append_to_page_id && summaryText) {
                  await notion.blocks.children.append({
                    block_id: String(args.append_to_page_id),
                    children: buildPlainTextBlocks(summaryText, "bulleted_list_item") as any
                  });
                }
                result = {
                  sourcePageId: summaryTarget.pageId,
                  summary: summaryText,
                  appended: !!args.append_to_page_id
                };
                break;
              case "create_smart_database":
                const parentRef = String(args.parent_reference || "").trim();
                let parentId = String(args.parent_id || "").trim();
                if (!parentId && parentRef) {
                  const parentPage = await findPageByReference(notion, parentRef);
                  if (!parentPage) {
                    throw new Error(`Could not find parent page for reference: ${parentRef}`);
                  }
                  parentId = parentPage.id;
                }
                result = await notion.databases.create({
                  parent: { type: "page_id", page_id: parentId || notionPageId } as any,
                  title: [{ text: { content: String(args.title || "AI Database").slice(0, 180) } }],
                  properties: buildDatabaseTemplateProperties(String(args.template_type || "task_tracker")) as any
                } as any);
                break;
              case "rewrite_page_content":
                const rewriteTarget = await resolvePageId(notion, args, notionPageId);
                const rewriteInput = await listPageText(notion, rewriteTarget.pageId);
                const rewritePrompt = [
                  `Objective: ${String(args.objective || "make this clearer")}`,
                  `Tone: ${String(args.tone || "professional")}`,
                  `Format: ${String(args.format || "bullets")}`,
                  "",
                  "Rewrite the following content accordingly:",
                  cleanModelText(rewriteInput, 15000)
                ].join("\n");
                const rewriteResponse = await retryGenerateContent(ai, {
                  model: "gemini-3.1-flash-lite-preview",
                  contents: [{ role: "user", parts: [{ text: rewritePrompt }] }],
                  config: {
                    systemInstruction: "Return only rewritten content. Keep it concise and useful.",
                    maxOutputTokens: 450,
                    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }
                  }
                });
                const rewritten = cleanModelText(rewriteResponse.text || "");
                if (args.append_to_page_id && rewritten) {
                  await notion.blocks.children.append({
                    block_id: String(args.append_to_page_id),
                    children: buildPlainTextBlocks(rewritten, "paragraph") as any
                  });
                }
                result = {
                  sourcePageId: rewriteTarget.pageId,
                  rewritten,
                  appended: !!args.append_to_page_id
                };
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

        latestToolSummaryText = toolResults
          .map(r => r.result?.error
            ? `- ${r.name}: failed (${String(r.result.error).slice(0, 120)})`
            : `- ${r.name}: success`)
          .join("\n");

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
      const responseWithActions = latestToolSummaryText
        ? `${finalResponseText || "I've completed the requested actions in your Notion workspace."}\n\nExecuted actions:\n${latestToolSummaryText}`
        : (finalResponseText || "I've completed the requested actions in your Notion workspace.");
      runtimeMetrics.requestsSucceeded += 1;
      res.json({ content: responseWithActions });

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
