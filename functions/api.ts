import serverless from "serverless-http";
import { createServer } from "../api/server.js";

let serverlessHandler: any;

export const handler = async (event: any, context: any) => {
  console.log(`[Netlify Function] Invoked: ${event.path} [${event.httpMethod}]`);
  try {
    if (!serverlessHandler) {
      console.log("[Netlify Function] Initializing server...");
      const app = await createServer();
      serverlessHandler = serverless(app, {
        binary: ["image/*", "font/*", "application/pdf"],
      });
    }
    return await serverlessHandler(event, context);
  } catch (err: any) {
    console.error("[Netlify Function] Initialization Error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal Server Error during initialization", details: err.message }),
    };
  }
};
