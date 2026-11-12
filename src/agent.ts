import type { Invoice } from "./gateway.js";
import type { ModelPlan } from "./rules.js";

export type CandidateLine = {
  invoice_id: string;
  invoice_date: string;
  line_index: number;
  name: string;
  description: string;
  quantity: string;
  unit_price: string;
};

// One small seam so a fake model can replace the real one in tests.
export interface Model {
  readonly label: string;
  complete(system: string, user: string): Promise<string>;
}
export interface Transcriber {
  readonly label: string;
  transcribe(audio: Buffer, mime: string, vocabulary?: string[]): Promise<string>;
}

export class InvalidReplyError extends Error {}

export const BATCH_SIZE = 80;

const SCHEMA = {
  product_phrase: "string: the product named in the recall, as the seller wrote it",
  from_date: "string: first day of the batch window, YYYY-MM-DD",
  to_date: "string: last day of the batch window, YYYY-MM-DD",
  hazard: "string: the problem in 8 words or fewer, no amounts",
  matches: [
    {
      invoice_id: "string, copied from the line",
      line_index: "integer, copied from the line",
      quote: "string: the line name copied character for character",
      verdict: '"recalled" when the line is the recalled product, "lookalike" when it only shares a word or looks similar',
      reason: "string: one sentence",
    },
  ],
  notice_template:
    "string: a short plain notice to one buyer, 2 to 4 sentences, with the placeholders {buyer}, {order}, {item} and {refund}. {refund} becomes a sentence the server writes about the refund. Write no amounts and no prices.",
};

export function systemPrompt(today: string): string {
  return [
    "You help a small food maker run a product recall over their invoices.",
    "The seller gives one sentence about a bad batch, then a list of invoice lines.",
    "Find every line that is the recalled product, and every line that a person could mistake for it.",
    "Mark a line 'recalled' when it is the same product. Mark it 'lookalike' when it shares the distinctive name word of the product (a flavour, an ingredient or a brand) but is a different product.",
    "Leave out lines that share only a generic category word such as pickle, achar, jar, sauce or candy.",
    "Judge the product only. Do not judge the dates: list matching lines from every date. The server checks the dates in code.",
    "Copy the quote from the line name character for character.",
    "In the notice, do not promise a return, a replacement or a refund. The server writes the {refund} sentence.",
    `Today is ${today}. When the sentence gives no year, use the most recent such dates that are not in the future.`,
    "Return JSON only, in this shape:",
    JSON.stringify(SCHEMA),
  ].join(" ");
}

export function userPrompt(sentence: string, lines: CandidateLine[]): string {
  return [
    `Recall sentence: ${sentence}`,
    "Invoice lines (JSON, one per row):",
    ...lines.map((l) => JSON.stringify(l)),
  ].join("\n");
}

export function candidates(invoices: Invoice[]): CandidateLine[] {
  return invoices.flatMap((inv) =>
    inv.lines.map((l) => ({
      invoice_id: inv.id,
      invoice_date: inv.invoiceDate,
      line_index: l.index,
      name: l.name,
      description: l.description,
      quantity: l.quantity,
      unit_price: (l.unitCents / 100).toFixed(2),
    })),
  );
}

function parsePlan(text: string): ModelPlan {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as Record<string, unknown>;
  } catch {
    throw new InvalidReplyError(`model returned no valid JSON: ${text.slice(0, 160)}`);
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.matches)) throw new InvalidReplyError("model returned no matches array");
  const str = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : "");
  return {
    product_phrase: str("product_phrase"),
    from_date: str("from_date"),
    to_date: str("to_date"),
    hazard: str("hazard"),
    matches: data.matches as unknown[],
    notice_template: str("notice_template"),
  };
}

// Sends lines in batches of 80. Each batch retries once on invalid JSON.
// The first batch gives the dates, hazard and template. Every batch adds matches.
export async function planRecall(model: Model, sentence: string, invoices: Invoice[], today: string, log: (e: string, d: string) => void = () => {}): Promise<ModelPlan> {
  const all = candidates(invoices);
  const batches: CandidateLine[][] = [];
  for (let i = 0; i < all.length; i += BATCH_SIZE) batches.push(all.slice(i, i + BATCH_SIZE));
  if (!batches.length) batches.push([]);
  let merged: ModelPlan | null = null;
  for (const [b, lines] of batches.entries()) {
    let plan: ModelPlan | null = null;
    for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
      try {
        plan = parsePlan(await model.complete(systemPrompt(today), userPrompt(sentence, lines)));
      } catch (err) {
        if (!(err instanceof InvalidReplyError) || attempt === 2) throw err;
        log("model.retry", `batch ${b + 1}: ${err.message}`);
      }
    }
    log("model.reply", `batch ${b + 1} of ${batches.length}: ${lines.length} lines in, ${plan!.matches.length} matches out`);
    if (!merged) merged = plan!;
    else merged.matches.push(...plan!.matches);
  }
  return merged!;
}

export type ApiConfig = { baseUrl: string; apiKey: string; model: string; sttModel?: string };

// Any OpenAI-compatible chat endpoint. Groq by default.
export function openAiCompatModel(cfg: ApiConfig, fetchImpl: typeof fetch = fetch): Model {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    label: `${new URL(cfg.baseUrl).host} (${cfg.model})`,
    async complete(system, user) {
      for (let attempt = 1; ; attempt++) {
        const res = await call(system, user);
        // Groq free tier: 429 names the wait. One wait of at most 20 s, then the error goes up.
        if (res.status === 429 && attempt === 1) {
          const wait = Number(/try again in ([\d.]+)s/.exec(await res.clone().text())?.[1] ?? "5");
          if (wait <= 20) {
            await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 250));
            continue;
          }
        }
        return read(res);
      }
    },
  };

  function call(system: string, user: string) {
    return fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        // Groq free tier counts this cap against 8000 tokens per minute, with the prompt.
        max_completion_tokens: 4500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  }

  async function read(res: Response): Promise<string> {
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      // Groq answers 400 json_validate_failed when the model wrote broken JSON. That earns the retry.
      if (res.status === 400 && text.includes("json_validate_failed")) throw new InvalidReplyError(`model API 400 json_validate_failed`);
      throw new Error(`model API ${res.status}: ${text}`);
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  }
}

// POST {base}/audio/transcriptions, multipart: file, model, language, response_format.
export function whisperTranscriber(cfg: ApiConfig, fetchImpl: typeof fetch = fetch): Transcriber {
  const model = cfg.sttModel || "whisper-large-v3-turbo";
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
  return {
    label: model,
    async transcribe(audio, mime, vocabulary) {
      const form = new FormData();
      // Whisper spells product names it has not heard ("Timor Atcher"). The prompt gives it the item names.
      if (vocabulary?.length) form.append("prompt", `Product names: ${vocabulary.join(", ")}.`.slice(0, 800));
      const ext = mime.includes("wav") ? "wav" : mime.includes("mp4") || mime.includes("m4a") ? "m4a" : mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : "mp3";
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `note.${ext}`);
      form.append("model", model);
      form.append("language", "en");
      form.append("response_format", "json");
      const res = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${cfg.apiKey}` }, body: form, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`speech API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { text?: string };
      return String(body.text ?? "").trim();
    },
  };
}
