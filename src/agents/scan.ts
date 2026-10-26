// 01 · Scan. Photos (or pasted text) → numbered lines, page by page.
//
// Photos go to a vision route on Nightshift, which transcribes each page line by line and
// says when a page is too blurry to read (the patient is asked to rescan it). Pasted text
// needs no model: it is numbered as page 1. Extract can send lines back here to be re-read.

import type { AgentContext } from "./context.ts";
import { parseJsonObject } from "../text.ts";
import type { ScanLine, ScanPage, ScanResult } from "../types.ts";

const VISION_ROUTE = process.env.VISION_ROUTE ?? "meterless/vision";

const TRANSCRIBE = `You transcribe one photographed page of a hospital discharge summary.
Copy the text exactly, line by line, top to bottom. Do not fix spelling, expand abbreviations, or add anything.
If a line is hard to read, give your best reading and mark it unclear.
If the page is too blurry, cut off or dark to read most of it, set readable to false and say why in problem.
Return JSON only: {"readable": true, "problem": null, "lines": [{"text": "...", "unclear": false}]}`;

export function scanText(text: string): ScanResult {
  // A form feed or a line like "--- page 2 ---" starts a new page.
  const chunks = text.replace(/\r\n?/g, "\n").split(/\f|\n-{2,}\s*page\s*\d+\s*-{2,}\n/i);
  const pages: ScanPage[] = chunks.map((chunk, i) => ({
    page: i + 1,
    readable: true,
    lines: chunk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((t, j) => ({ id: `p${i + 1}:L${j + 1}`, text: t })),
  }));
  return { pages: pages.filter((p) => p.lines.length), source: "text" };
}

export async function scanImages(ctx: AgentContext, images: string[]): Promise<ScanResult> {
  const pages: ScanPage[] = [];
  for (let i = 0; i < images.length; i++) {
    const n = i + 1;
    ctx.say("scan", "scan", "info", `Reading page ${n} of ${images.length}…`);
    const res = await ctx.llm({
      agent: "scan",
      route: VISION_ROUTE,
      json: true,
      maxTokens: 4000,
      messages: [
        { role: "system", content: TRANSCRIBE },
        { role: "user", content: [{ type: "text", text: `Page ${n}.` }, { type: "image_url", image_url: { url: images[i] } }] },
      ],
    });
    const out = parseJsonObject<{ readable: boolean; problem: string | null; lines: { text: string; unclear?: boolean }[] }>(res.content);
    const lines: ScanLine[] = (out.lines ?? [])
      .filter((l) => l?.text?.trim())
      .map((l, j) => ({ id: `p${n}:L${j + 1}`, text: l.text.trim(), ...(l.unclear && { unclear: true }) }));
    pages.push({ page: n, lines, readable: out.readable !== false && lines.length > 0, ...(out.problem && { problem: out.problem }) });
    ctx.save("scan", `page${n}`, { input: { page: n }, output: pages[pages.length - 1] });
  }
  return { pages, source: "image" };
}

/** Extract asked for specific lines to be read again: look at the page once more, only at those lines. */
export async function rereadLines(ctx: AgentContext, scan: ScanResult, images: string[], requests: { source: string; reason: string }[]): Promise<number> {
  let changed = 0;
  const byPage = new Map<number, { source: string; reason: string }[]>();
  for (const r of requests) {
    const page = Number(r.source.match(/^p(\d+):/)?.[1]);
    if (page && images[page - 1]) byPage.set(page, [...(byPage.get(page) ?? []), r]);
  }
  for (const [page, reqs] of byPage) {
    const current = scan.pages.find((p) => p.page === page)!;
    const listing = reqs
      .map((r) => {
        const line = current.lines.find((l) => l.id === r.source.split("-")[0]);
        return `${r.source}: currently read as "${line?.text ?? "?"}" (why re-read: ${r.reason})`;
      })
      .join("\n");
    const res = await ctx.llm({
      agent: "scan",
      route: VISION_ROUTE,
      json: true,
      maxTokens: 1500,
      messages: [
        {
          role: "system",
          content: `You re-read specific lines of a photographed discharge summary page. Read each listed line again, carefully, exactly as printed.
Return JSON only: {"lines": [{"id": "p1:L4", "text": "...", "unclear": false}]}`,
        },
        { role: "user", content: [{ type: "text", text: listing }, { type: "image_url", image_url: { url: images[page - 1] } }] },
      ],
    });
    const out = parseJsonObject<{ lines: { id: string; text: string; unclear?: boolean }[] }>(res.content);
    for (const l of out.lines ?? []) {
      const line = current.lines.find((x) => x.id === l.id);
      if (!line || !l.text?.trim()) continue;
      if (line.text !== l.text.trim()) changed++;
      line.text = l.text.trim();
      line.unclear = !!l.unclear || undefined;
    }
    ctx.save("scan", `reread-p${page}`, { input: reqs, output: out });
  }
  return changed;
}

/** "p1:L4 | text" listing used in every prompt that needs the original wording. */
export function numberedLines(scan: ScanResult, only?: Set<string>): string {
  return scan.pages
    .flatMap((p) => p.lines)
    .filter((l) => !only || only.has(l.id))
    .map((l) => `${l.id} | ${l.text}${l.unclear ? "   [unclear]" : ""}`)
    .join("\n");
}

/** Every line id in the scan, for source validation. A range "p1:L4-6" is valid if its start is. */
export function lineIds(scan: ScanResult): Set<string> {
  return new Set(scan.pages.flatMap((p) => p.lines.map((l) => l.id)));
}

export function lineText(scan: ScanResult, source: string): string | null {
  const m = source.match(/^p(\d+):L(\d+)(?:-L?(\d+))?$/);
  if (!m) return null;
  const page = scan.pages.find((p) => p.page === Number(m[1]));
  if (!page) return null;
  const from = Number(m[2]);
  const to = m[3] ? Number(m[3]) : from;
  const lines = page.lines.filter((l) => {
    const n = Number(l.id.split(":L")[1]);
    return n >= from && n <= to;
  });
  return lines.length ? lines.map((l) => l.text).join(" ") : null;
}
