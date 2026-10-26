// Client for Meterless Nightshift, the app's only AI provider.
//
// Nightshift exposes the Meterless Runtime as an OpenAI-compatible API on the machine that
// runs it (default http://127.0.0.1:8088/v1). Every agent calls chat() here; nothing in the
// app talks to a model vendor directly.
//
// What this adds on top of a plain OpenAI call:
//   - Provider contract: bearer token, meterless-app header, 180 s timeout, URL normalising,
//     online / unauthorized / offline status from GET /v1/models, Auto Detect.
//   - Isolation: every call gets its own meterless-scope, so Nightshift's built-in memory and
//     answer cache never carry one patient's text (or one agent's output) into another call.
//   - Clean answers: reasoning text before </think> is stripped from the content.
//   - Evidence: one JSONL trace line per call with the routed model and the signed receipt id.
//   - SAMPLE_MODE=true replays recorded responses, so the app runs with no Nightshift at all.
//
// Settings (environment):
//   METERLESS_BASE_URL       default http://127.0.0.1:8088/v1 (any pasted form is normalised)
//   METERLESS_RUNTIME_TOKEN  the runtime's proxy-token. If unset, read from the local
//                            Nightshift state folder (%LOCALAPPDATA%\ai.meterless.runtime).
//   METERLESS_APP_ID         default day-one
//   SAMPLE_MODE=true         replay samples/nightshift/<agent>/<key>.json, no network
//   NIGHTSHIFT_RECORD=true   save every live response there, to build the samples
//   RUNS_DIR                 where traces go, default runs/

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8088/v1";
const TIMEOUT_MS = 180_000; // a cold model load can take minutes
const MAX_ATTEMPTS = 3; // first try + at most 2 retries, network errors and 5xx only
const DETECT_PORTS = [8088, 8090, 8787, 11434];
const DETECT_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

export type Status = "online" | "unauthorized" | "offline";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface Message {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ChatRequest {
  agent: string; // scan | extract | lookup | simplify | safety_checker | qa
  jobId: string; // one pipeline run (one uploaded discharge summary)
  route: string; // a meterless/* routing mode, e.g. meterless/text or meterless/judge
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  json?: boolean; // ask for a JSON object response
  attempt?: number; // Simplify <-> Safety checker retry number, for the trace
}

export interface ChatResult {
  content: string; // the answer, reasoning removed
  routedModel: string | null; // the model that actually answered
  receiptId: string | null; // Nightshift's signed compute receipt
  usage: { input: number; output: number } | null;
  latencyMs: number;
  mode: "live" | "sample";
  finishReason: string | null; // "length" means the answer was cut off at maxTokens
}

export class NightshiftError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "NightshiftError";
    this.status = status;
  }
}

/** Accept a pasted URL with or without a scheme or path, and return <host>/v1. */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  const u = new URL(url);
  let path = u.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(chat\/completions|models|healthz)$/, "");
  path = path.replace(/\/v1$/, "");
  return `${u.protocol}//${u.host}${path}/v1`;
}

/** Remove the model's reasoning: anything up to and including the last </think>. */
export function stripReasoning(content: string): string {
  const end = content.lastIndexOf("</think>");
  const answer = end >= 0 ? content.slice(end + "</think>".length) : content;
  return answer.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Classify a GET /v1/models response. Only Nightshift lists meterless/* ids; Ollama does not. */
export function classifyModelsResponse(status: number, body: unknown): Status {
  if (status === 401 || status === 403) return "unauthorized";
  if (status !== 200) return "offline";
  const data = (body as { data?: { id?: string }[] } | null)?.data;
  return Array.isArray(data) && data.some((m) => m?.id?.startsWith("meterless/")) ? "online" : "offline";
}

export interface NightshiftOptions {
  baseUrl?: string;
  token?: string;
  appId?: string;
  sampleMode?: boolean;
  record?: boolean;
  runsDir?: string;
  samplesDir?: string;
  fetchImpl?: typeof fetch;
}

export class Nightshift {
  readonly baseUrl: string;
  readonly appId: string;
  readonly sampleMode: boolean;
  private readonly token: string | null;
  private readonly record: boolean;
  private readonly runsDir: string;
  private readonly samplesDir: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: NightshiftOptions = {}) {
    const env = process.env;
    this.baseUrl = normalizeBaseUrl(opts.baseUrl ?? env.METERLESS_BASE_URL ?? DEFAULT_BASE_URL);
    this.token = opts.token ?? env.METERLESS_RUNTIME_TOKEN ?? readLocalToken();
    this.appId = opts.appId ?? env.METERLESS_APP_ID ?? "day-one";
    this.sampleMode = opts.sampleMode ?? env.SAMPLE_MODE === "true";
    this.record = opts.record ?? env.NIGHTSHIFT_RECORD === "true";
    this.runsDir = opts.runsDir ?? env.RUNS_DIR ?? "runs";
    this.samplesDir = opts.samplesDir ?? join("samples", "nightshift");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** online, unauthorized (show a token field), or offline. /healthz alone proves nothing. */
  async status(): Promise<Status> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      const body = res.status === 200 ? await res.json().catch(() => null) : null;
      return classifyModelsResponse(res.status, body);
    } catch {
      return "offline";
    }
  }

  /** The routes and models Nightshift offers, with their availability. Empty if unreachable. */
  async listModels(): Promise<{ id: string; meterless?: { availability?: string } }[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      return res.ok ? ((await res.json()).data ?? []) : [];
    } catch {
      return [];
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = {
      model: req.route,
      messages: req.messages,
      ...(req.maxTokens != null && { max_tokens: req.maxTokens }),
      ...(req.temperature != null && { temperature: req.temperature }),
      ...(req.json && { response_format: { type: "json_object" } }),
    };
    const key = sampleKey(req.agent, body);
    const started = Date.now();

    if (this.sampleMode) {
      const raw = this.readSample(req.agent, key);
      const result = toResult(raw, Date.now() - started, "sample");
      this.trace(req, result, "ok");
      return result;
    }

    // A fresh scope per call: Nightshift fences its memory and cache by scope, so nothing
    // from an earlier call (another patient, or another agent's draft) is injected here.
    const scope = `${this.appId}.${req.jobId}.${req.agent}.${randomUUID().slice(0, 8)}`;
    let lastError: NightshiftError | null = null;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          // tier-split off: one answer phase. Split, Nightshift sometimes returned only its
          // internal planning step ({"steps": [...]}) when the execution phase failed.
          headers: { ...this.headers(), "meterless-scope": scope, "meterless-tier-split": "off", "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const raw = await res.json().catch(() => null);
        if (res.status === 401 || res.status === 403) {
          throw new NightshiftError("Nightshift rejected the token (unauthorized). Set METERLESS_RUNTIME_TOKEN.", res.status);
        }
        if (!res.ok || !raw?.choices?.length) {
          const msg = String(raw?.error?.message ?? raw?.error ?? `HTTP ${res.status}`);
          lastError = new NightshiftError(`Nightshift call failed: ${msg}`, res.status);
          // Retry server errors, and an upstream model the provider account can't reach
          // (Nightshift's router may pick a different model on the next try).
          if (res.status >= 500 || /not found for account/i.test(msg)) {
            lastError = new NightshiftError(lastError.message, null);
            continue;
          }
          throw lastError;
        }
        if (this.record) this.writeSample(req.agent, key, raw);
        const result = toResult(raw, Date.now() - started, "live");
        this.trace(req, result, "ok", raw);
        return result;
      } catch (err) {
        if (err instanceof NightshiftError && err.status !== null && err.status < 500) {
          this.traceError(req, err, Date.now() - started);
          throw err;
        }
        lastError = err instanceof NightshiftError ? err : new NightshiftError(`Nightshift unreachable: ${(err as Error).message}`);
      }
    }
    this.traceError(req, lastError!, Date.now() - started);
    throw lastError!;
  }

  private headers(): Record<string, string> {
    return {
      ...(this.token && { authorization: `Bearer ${this.token}` }),
      "meterless-app": this.appId,
    };
  }

  private trace(req: ChatRequest, result: ChatResult, status: string, raw?: any): void {
    const m = raw?.meterless;
    this.appendTrace(req.jobId, {
      ts: new Date().toISOString(),
      agent: req.agent,
      attempt: req.attempt ?? 1,
      route: req.route,
      model: result.routedModel,
      receipt_id: result.receiptId,
      phases: m?.phases?.map((p: any) => ({ phase: p.phase, model: p.model, ms: p.ms })) ?? undefined,
      cache: m?.cache?.status,
      memory_injected: m?.receipt?.hmem?.injected ?? 0,
      ms: result.latencyMs,
      finish: result.finishReason ?? undefined,
      tokens_in: result.usage?.input,
      tokens_out: result.usage?.output,
      mode: result.mode,
      status,
    });
  }

  private traceError(req: ChatRequest, err: NightshiftError, ms: number): void {
    this.appendTrace(req.jobId, {
      ts: new Date().toISOString(),
      agent: req.agent,
      attempt: req.attempt ?? 1,
      route: req.route,
      ms,
      mode: "live",
      status: "error",
      error: err.message,
    });
  }

  private appendTrace(jobId: string, line: object): void {
    const file = join(this.runsDir, safeName(jobId), "trace.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(line) + "\n");
  }

  private readSample(agent: string, key: string): any {
    const file = join(this.samplesDir, safeName(agent), `${key}.json`);
    if (!existsSync(file)) {
      throw new NightshiftError(`SAMPLE_MODE: no recorded response at ${file}. Record one with NIGHTSHIFT_RECORD=true.`);
    }
    return JSON.parse(readFileSync(file, "utf-8"));
  }

  private writeSample(agent: string, key: string, raw: any): void {
    const file = join(this.samplesDir, safeName(agent), `${key}.json`);
    mkdirSync(dirname(file), { recursive: true });
    // Keep only what replay needs; the full receipt stays in Nightshift.
    const slim = {
      choices: raw.choices,
      usage: raw.usage,
      meterless: {
        routed_model: raw.meterless?.routed_model,
        receipt_id: raw.meterless?.receipt_id,
        phases: raw.meterless?.phases,
      },
    };
    writeFileSync(file, JSON.stringify(slim, null, 2));
  }
}

/** Try the usual ports and hosts; return the first online or unauthorized runtime. */
export async function autoDetect(fetchImpl: typeof fetch = fetch): Promise<{ baseUrl: string; status: Status } | null> {
  for (const port of DETECT_PORTS) {
    for (const host of DETECT_HOSTS) {
      const client = new Nightshift({ baseUrl: `${host}:${port}`, fetchImpl, sampleMode: false });
      const status = await client.status();
      if (status !== "offline") return { baseUrl: client.baseUrl, status };
    }
  }
  return null;
}

function toResult(raw: any, latencyMs: number, mode: "live" | "sample"): ChatResult {
  const content = raw?.choices?.[0]?.message?.content ?? "";
  return {
    content: stripReasoning(typeof content === "string" ? content : JSON.stringify(content)),
    routedModel: raw?.meterless?.routed_model ?? raw?.model ?? null,
    receiptId: raw?.meterless?.receipt_id ?? null,
    usage: raw?.usage ? { input: raw.usage.prompt_tokens, output: raw.usage.completion_tokens } : null,
    latencyMs,
    mode,
    finishReason: raw?.choices?.[0]?.finish_reason ?? null,
  };
}

/** Stable key for a request, so SAMPLE_MODE finds the response recorded for it. */
function sampleKey(agent: string, body: object): string {
  return createHash("sha256").update(agent + "\n" + JSON.stringify(body)).digest("hex").slice(0, 16);
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

/** The runtime writes its token into its state folder: AppData\Local on Windows, Application Support on macOS. */
function readLocalToken(): string | null {
  const dirs = [
    join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ai.meterless.runtime"),
    join(homedir(), "Library", "Application Support", "ai.meterless.runtime"),
  ];
  for (const dir of dirs) {
    try {
      const token = readFileSync(join(dir, "proxy-token"), "utf-8").trim();
      if (token) return token;
    } catch {
      // not this OS, or Nightshift isn't installed
    }
  }
  return null;
}
