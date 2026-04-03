import serverless from "serverless-http";
import { createServer } from "../server.ts";

let serverlessHandler: any;

export const handler = async (event: any, context: any) => {
  if (!serverlessHandler) {
    const app = await createServer();
    serverlessHandler = serverless(app);
  }
  return serverlessHandler(event, context);
};
