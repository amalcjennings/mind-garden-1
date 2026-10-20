// Local development server: serves public/ and runs the real API function
// against a local Netlify Blobs emulator stored in .dev-data/.
// Usage: npm run dev   (EDIT_PASSWORD defaults to "dev")
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { BlobsServer } from "@netlify/blobs/server";
import { setEnvironmentContext } from "@netlify/blobs";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const PORT = Number(process.env.PORT || 8888);
process.env.EDIT_PASSWORD ??= "dev";

const blobs = new BlobsServer({ directory: join(root, ".dev-data"), token: "dev-token" });
const { port: blobsPort } = await blobs.start();
const blobsURL = `http://localhost:${blobsPort}`;
setEnvironmentContext({ edgeURL: blobsURL, uncachedEdgeURL: blobsURL, siteID: "local-dev", token: "dev-token" });

const { default: handler } = await import("../netlify/functions/api.mjs");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(pathname, res) {
  let file = normalize(join(publicDir, decodeURIComponent(pathname)));
  if (!file.startsWith(publicDir)) file = join(publicDir, "index.html");
  try {
    if (!(await stat(file)).isFile()) throw new Error();
  } catch {
    file = join(publicDir, "index.html"); // SPA fallback, same as netlify.toml
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(await readFile(file));
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const response = await handler(
          new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body })
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } else {
        await serveStatic(url.pathname, res);
      }
    } catch (err) {
      console.error(err);
      res.writeHead(500).end(String(err));
    }
  })
  .listen(PORT, () => {
    console.log(`Notes running at http://localhost:${PORT}  (edit password: ${process.env.EDIT_PASSWORD})`);
  });
