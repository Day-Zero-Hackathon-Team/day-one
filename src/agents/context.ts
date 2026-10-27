// What every agent gets: the Nightshift client, the job's shared message board, and the audit
// trail (every agent's input and output is saved under runs/<job>/).

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import type { ChatRequest, ChatResult, Nightshift } from "../nightshift.ts";
import type { AgentMessage, AgentName } from "../types.ts";

export class AgentContext {
  private seq = 0;
  readonly models: { agent: string; model: string | null; receipt: string | null }[] = [];

  constructor(
    readonly ns: Nightshift,
    readonly jobId: string,
    readonly runDir: string,
    private readonly onMessage: (m: AgentMessage) => void,
  ) {
    mkdirSync(runDir, { recursive: true });
    this.seq = readdirSync(runDir).filter((f) => /^\d{2}-.*\.json$/.test(f)).length; // reopened jobs keep numbering
  }

  /** Post a message on the shared board (shown in the UI as the agent conversation, and logged). */
  say(from: AgentName, to: AgentMessage["to"], kind: AgentMessage["kind"], text: string): void {
    this.onMessage({ ts: new Date().toISOString(), from, to, kind, text });
    log(this.jobId, { agent_name: from, target_agent: to, action: kind, output_summary: text });
  }

  /** Call a model through Nightshift and keep the routed model for the evidence panel and the log. */
  async llm(req: Omit<ChatRequest, "jobId">): Promise<ChatResult> {
    let res: ChatResult;
    try {
      res = await this.ns.chat({ ...req, jobId: this.jobId });
    } catch (err) {
      log(this.jobId, { agent_name: req.agent, action: "model_call", status: "error", output_summary: `Nightshift ${req.route} failed: ${(err as Error).message}` });
      throw err;
    }
    this.models.push({ agent: req.agent, model: res.routedModel, receipt: res.receiptId });
    log(this.jobId, {
      agent_name: req.agent,
      action: "model_call",
      model: res.routedModel,
      receipt_id: res.receiptId,
      latency_ms: res.latencyMs,
      output_summary: `Nightshift ${req.route} answered with ${res.routedModel ?? "an unnamed model"}${res.mode === "sample" ? " (recorded response, sample mode)" : ` in ${(res.latencyMs / 1000).toFixed(1)} s`}`,
    });
    return res;
  }

  /** Save one agent step's input and output (the audit trail). */
  save(agent: string, step: string, data: { input?: unknown; output?: unknown }): void {
    const file = join(this.runDir, `${String(++this.seq).padStart(2, "0")}-${agent}-${step}.json`);
    writeFileSync(file, JSON.stringify(data, null, 2));
  }
}
