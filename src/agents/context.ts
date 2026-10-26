// What every agent gets: the Nightshift client, the job's shared message board, and the audit
// trail (every agent's input and output is saved under runs/<job>/).

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  /** Post a message on the shared board (shown in the UI as the agent conversation). */
  say(from: AgentName, to: AgentMessage["to"], kind: AgentMessage["kind"], text: string): void {
    this.onMessage({ ts: new Date().toISOString(), from, to, kind, text });
  }

  /** Call a model through Nightshift and keep the routed model for the evidence panel. */
  async llm(req: Omit<ChatRequest, "jobId">): Promise<ChatResult> {
    const res = await this.ns.chat({ ...req, jobId: this.jobId });
    this.models.push({ agent: req.agent, model: res.routedModel, receipt: res.receiptId });
    return res;
  }

  /** Save one agent step's input and output (the audit trail). */
  save(agent: string, step: string, data: { input?: unknown; output?: unknown }): void {
    const file = join(this.runDir, `${String(++this.seq).padStart(2, "0")}-${agent}-${step}.json`);
    writeFileSync(file, JSON.stringify(data, null, 2));
  }
}
