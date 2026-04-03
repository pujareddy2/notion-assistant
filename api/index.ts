import { createServer } from "../server";

let app: any;

export default async (req: any, res: any) => {
  try {
    if (!app) {
      app = await createServer();
    }
    // Vercel's req/res are compatible with Express
    return app(req, res);
  } catch (err: any) {
    console.error("Vercel Function Error:", err);
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
