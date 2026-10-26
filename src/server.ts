// Web server: serves the page in public/ and the job API. Node's standard library only.
//
//   npm start            then open http://localhost:3100
//
//   POST /api/jobs       {text} or {images: [dataURL, ...]}  → {id}
//   GET  /api/jobs/:id   progress, the agent conversation, and the result
//   POST /api/jobs/:id/ask  {question} → an answer from this patient's data only, with sources
//   GET  /api/status     Nightshift / Zetaris / sample mode
//   GET  /api/samples    the sample discharge summaries in samples/inputs/

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { ROOT, loadDotEnv, sampleMode } from "./config.ts";

loadDotEnv();

const { JobRunner } = await import("./pipeline.ts");
const { Nightshift } = await import("./nightshift.ts");
const { ping } = await import("./zetaris.ts");

const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC = join(ROOT, "public");
const MAX_BODY = 30 * 1024 * 1024; // a few phone photos as data URLs
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

const runner = new JobRunner();
let statusCache: { at: number; value: unknown } | null = null;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
  }
});

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method === "POST" && url.pathname === "/api/jobs") {
    const body = JSON.parse(await readBody(req));
    const text = typeof body.text === "string" ? body.text : "";
    const images = Array.isArray(body.images) ? body.images.filter((i: unknown) => typeof i === "string" && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(i)) : [];
    if (!text.trim() && !images.length) return send(res, 400, { error: "Upload a photo or paste the text of the discharge summary." });
    if (images.length > 10) return send(res, 400, { error: "Up to 10 pages at a time." });
    const job = runner.start({ text, images });
    return send(res, 202, { id: job.id });
  }
  const ask = url.pathname.match(/^\/api\/jobs\/([\w-]+)\/ask$/);
  if (req.method === "POST" && ask) {
    const { question } = JSON.parse(await readBody(req));
    if (typeof question !== "string" || !question.trim()) return send(res, 400, { error: "Type a question first." });
    try {
      return send(res, 200, await runner.ask(ask[1], question.trim().slice(0, 500)));
    } catch (err) {
      return send(res, 409, { error: (err as Error).message });
    }
  }
  const m = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
  if (req.method === "GET" && m) {
    const job = runner.get(m[1]); // includes jobs saved before a restart
    return job ? send(res, 200, job) : send(res, 404, { error: "no such job" });
  }
  if (req.method === "GET" && url.pathname === "/api/status") return send(res, 200, await status());
  if (req.method === "GET" && url.pathname === "/api/samples") {
    const dir = join(ROOT, "samples", "inputs");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".txt")).sort() : [];
    return send(res, 200, files.map((f) => ({ name: f.replace(/\.txt$/, "").replace(/[-_]/g, " "), text: readFileSync(join(dir, f), "utf-8") })));
  }
  send(res, 404, { error: "not found" });
}

async function status(): Promise<unknown> {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  const ns = new Nightshift();
  let vision = false;
  const nightshift: string = sampleMode() ? "sample mode" : await ns.status();
  if (nightshift === "online") {
    const route = process.env.VISION_ROUTE ?? "meterless/vision";
    vision = (await ns.listModels()).some((m) => m.id === route && m.meterless?.availability !== "unavailable");
  }
  const zetaris = sampleMode() ? { ok: true, detail: "sample mode" } : await ping();
  const value = { sampleMode: sampleMode(), nightshift, vision: sampleMode() ? false : vision, zetaris };
  statusCache = { at: Date.now(), value };
  return value;
}

function serveStatic(res: ServerResponse, path: string): void {
  const file = normalize(join(PUBLIC, path === "/" ? "index.html" : path));
  if (!file.startsWith(PUBLIC) || !existsSync(file)) return send(res, 404, { error: "not found" });
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("upload too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

server.listen(PORT, HOST, () => {
  console.log(`day-one running at http://localhost:${PORT}${sampleMode() ? "  (SAMPLE_MODE: recorded responses, no Nightshift or Zetaris needed)" : ""}`);
});
