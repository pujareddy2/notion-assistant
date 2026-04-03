import serverless from "serverless-http";
import { createServer } from "../server";

let handler: any;

export default async (req: any, res: any) => {
  if (!handler) {
    const app = await createServer();
    handler = serverless(app);
  }
  return handler(req, res);
};
