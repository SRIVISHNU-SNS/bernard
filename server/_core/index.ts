import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { storagePut } from "../storage";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120) || "evidence";
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  app.use(express.json({ limit: "110mb" }));
  app.use(express.urlencoded({ limit: "110mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  app.post("/api/upload", async (req, res) => {
    try {
      const body = req.body as { data?: string; fileName?: string; mimeType?: string };
      const data = body.data || "";
      const mimeType = body.mimeType || "";
      if (!data || !mimeType || (!mimeType.startsWith("image/") && !mimeType.startsWith("video/"))) {
        res.status(400).json({ error: "Upload must be an image or video." });
        return;
      }
      const base64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
      const buffer = Buffer.from(base64, "base64");
      const maxBytes = mimeType.startsWith("video/") ? 80 * 1024 * 1024 : 10 * 1024 * 1024;
      if (buffer.length === 0 || buffer.length > maxBytes) {
        res.status(413).json({ error: `This file is larger than the ${mimeType.startsWith("video/") ? "80 MB" : "10 MB"} limit.` });
        return;
      }
      const stored = await storagePut(`fixpoint/transient/${Date.now()}-${safeFileName(body.fileName || "evidence")}`, buffer, mimeType);
      res.json(stored);
    } catch (error) {
      console.error("[Fixpoint] Upload failed", error);
      res.status(500).json({ error: "The file could not be processed. Try another photo or a shorter clip." });
    }
  });

  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));
  if (process.env.NODE_ENV === "development") await setupVite(app, server);
  else serveStatic(app);

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  server.listen(port, () => console.log(`Server running on http://localhost:${port}/`));
}

startServer().catch(console.error);
