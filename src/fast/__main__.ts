import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = parseInt(process.env.PORT ?? "8004", 10);
console.log(`[swe-fast] starting on 0.0.0.0:${port}`);
serve({ fetch: app.fetch, port });
