import { createServer } from "./server.js";

let app: any;

export default async (req: any, res: any) => {
  console.log(`[Vercel] Request: ${req.method} ${req.url}`);
  try {
    if (!app) {
      console.log("[Vercel] Initializing server...");
      app = await createServer();
      console.log("[Vercel] Server initialized successfully");
    }
    
    // Vercel's req/res are compatible with Express
    // We don't return the app call, we just execute it
    app(req, res);
  } catch (err: any) {
    console.error("[Vercel] Critical Function Error:", err);
    if (res && typeof res.status === 'function') {
      res.status(500).json({ 
        error: "Failed to initialize server", 
        details: err.message 
      });
    } else {
      throw err;
    }
  }
};
