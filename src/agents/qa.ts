// + · Q&A. Answers follow-up questions ("Can I shower?") using only this patient's data:
// H-MEM recalls the most relevant memories, and the model answers from those plus the original
// lines and the checked summary. Anything they don't cover gets "ask your care team".
// Every answer cites its sources, and a code check drops any it made up.

import type { AgentContext } from "./context.ts";
import { lineIds, numberedLines } from "./scan.ts";
import { parseJsonObject } from "../text.ts";
import type { PatientMemory } from "../memory.ts";
import type { FinalOutput } from "../types.ts";

export const ASK_CARE_TEAM = "Your papers don't say. Please ask your care team.";

export interface QaAnswer {
  question: string;
  answer: string;
  sources: string[];
  answered: boolean;
  recalled: string[]; // memory sources H-MEM ranked highest
}

export async function answer(ctx: AgentContext, out: FinalOutput, memory: PatientMemory, question: string): Promise<QaAnswer> {
  const recall = memory.recall(question);
  const bullets = [...out.summary.sections.flatMap((s) => s.bullets), ...out.summary.call_911_if].map((b) => ({ text: b.text, sources: b.sources }));
  const input = [
    `Question: ${question}`,
    `Most relevant memories (H-MEM recall):\n${recall.context || "none"}`,
    `Original lines:\n${numberedLines(out.scan)}`,
    `Checked plain-language summary:\n${JSON.stringify(bullets)}`,
  ].join("\n\n");
  const ask = (retry: boolean) =>
    ctx.llm({
      agent: "qa",
      route: "meterless/text",
      json: true,
      maxTokens: 1500,
      messages: [
        {
          role: "system",
          content: `You answer a patient's question about their own hospital discharge papers, in plain words (grade 6, at most 3 short sentences).
Use ONLY the memories, original lines and summary given. Cite the line ids you used (p1:L4).
If they don't answer the question, set answered to false and do not guess. Never give new medical advice.
Return JSON only: {"answered": true, "answer": "...", "sources": ["p1:L20"]}`,
        },
        { role: "user", content: input },
        ...(retry ? [{ role: "user" as const, content: 'Reply with only this JSON object and nothing else: {"answered": true|false, "answer": "...", "sources": ["p1:L4"]}' }] : []),
      ],
    });
  type Raw = { answered?: boolean; answer?: string; sources?: string[] };
  // Models sometimes wrap the answer, e.g. {"analysis": ..., "final": {...}}.
  const unwrap = (p: Record<string, unknown>): Raw => ("answer" in p ? p : ((Object.values(p).find((v) => v && typeof v === "object" && "answer" in (v as object)) as Raw) ?? p));
  // An unusable answer (cut off, not JSON, or its notes with no "answer" in them) is asked once more,
  // then becomes "ask your care team".
  let parsed: Raw & Record<string, unknown> = {};
  for (let i = 1; i <= 2; i++) {
    try {
      parsed = parseJsonObject((await ask(i > 1)).content);
      if (typeof unwrap(parsed).answer === "string") break;
    } catch {
      parsed = {};
    }
  }
  const raw = unwrap(parsed);
  const ids = lineIds(out.scan);
  const sources = (raw.sources ?? []).filter((s) => ids.has(String(s).split("-")[0]));
  // No real source, no answer: nothing reaches the patient without one.
  const answered = !!raw.answered && !!raw.answer?.trim() && sources.length > 0;
  const result: QaAnswer = { question, answer: answered ? raw.answer!.trim() : ASK_CARE_TEAM, sources: answered ? sources : [], answered, recalled: recall.sources };
  ctx.save("qa", "answer", { input, output: { raw: parsed, result } });
  return result;
}
