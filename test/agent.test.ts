import assert from "node:assert/strict";
import { test } from "node:test";
import { BATCH_SIZE, InvalidReplyError, candidates, openAiCompatModel, planRecall, whisperTranscriber, type Model } from "../src/agent.js";
import type { Invoice, Line } from "../src/gateway.js";

function line(index: number, over: Partial<Line> = {}): Line {
  return { index, itemId: `I${index}`, name: "Timur achar (jar, 250 g)", description: "Sichuan pepper pickle", quantity: "2", unitCents: 850, taxName: null, taxPercent: null, taxCents: 0, ...over };
}

function invoice(id: string, lines: Line[]): Invoice {
  return { id, number: id, status: "UNPAID", invoiceDate: "2026-03-05", buyer: "Asha Gurung", email: "asha@example.com", note: "", reference: "lot-recall-demo", totalCents: 0, paidCents: 0, refundedCents: 0, payerUrl: null, lines };
}

// N invoices with one line each.
const many = (n: number) => Array.from({ length: n }, (_, i) => invoice(`INV-${i}`, [line(0)]));

const VALID = JSON.stringify({ product_phrase: "timur achar", from_date: "2026-03-01", to_date: "2026-03-20", hazard: "may contain peanuts", matches: [], notice_template: "Dear {buyer}" });

// Replies in order, then repeats the last one. Records every call.
function fakeModel(...replies: (string | Error)[]) {
  const calls: { system: string; user: string }[] = [];
  const model: Model = {
    label: "fake",
    async complete(system, user) {
      const reply = replies[Math.min(calls.length, replies.length - 1)];
      calls.push({ system, user });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { model, calls };
}

const planJson = (over: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(VALID), ...over });
const userLines = (user: string) => user.split("\n").slice(2);

// planRecall

test("planRecall retries once after invalid JSON and then succeeds", async () => {
  const { model, calls } = fakeModel("not json at all", VALID);
  const logs: string[] = [];
  const plan = await planRecall(model, "recall the timur achar", many(2), "2026-11-12", (e) => logs.push(e));
  assert.equal(calls.length, 2);
  assert.equal(plan.product_phrase, "timur achar");
  assert.equal(plan.from_date, "2026-03-01");
  assert.ok(logs.includes("model.retry"));
});

test("planRecall throws InvalidReplyError after two invalid replies", async () => {
  const { model, calls } = fakeModel("nope", "still nope");
  await assert.rejects(() => planRecall(model, "recall", many(1), "2026-11-12"), InvalidReplyError);
  assert.equal(calls.length, 2);
});

test("planRecall treats a reply with no matches array as invalid", async () => {
  const { model, calls } = fakeModel(JSON.stringify({ product_phrase: "x" }));
  await assert.rejects(() => planRecall(model, "recall", many(1), "2026-11-12"), /no matches array/);
  assert.equal(calls.length, 2);
});

test("planRecall does not retry an error that is not an invalid reply", async () => {
  const { model, calls } = fakeModel(new Error("model API 500: boom"));
  await assert.rejects(() => planRecall(model, "recall", many(1), "2026-11-12"), /model API 500/);
  assert.equal(calls.length, 1);
});

test("planRecall reads JSON wrapped in a code fence", async () => {
  const { model } = fakeModel("```json\n" + VALID + "\n```");
  const plan = await planRecall(model, "recall", many(1), "2026-11-12");
  assert.equal(plan.hazard, "may contain peanuts");
});

test("planRecall sends the lines in batches of BATCH_SIZE and merges the matches", async () => {
  assert.equal(BATCH_SIZE, 80);
  const matchFor = (id: string) => ({ invoice_id: id, line_index: 0, quote: "Timur achar (jar, 250 g)", verdict: "recalled", reason: "same" });
  const { model, calls } = fakeModel(
    planJson({ from_date: "2026-03-01", to_date: "2026-03-20", matches: [matchFor("INV-0")] }),
    planJson({ from_date: "2020-01-01", to_date: "2020-01-02", notice_template: "second", matches: [matchFor("INV-80")] }),
    planJson({ from_date: "2019-01-01", to_date: "2019-01-02", notice_template: "third", matches: [matchFor("INV-160")] }),
  );
  const plan = await planRecall(model, "recall", many(170), "2026-11-12");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => userLines(c.user).length), [80, 80, 10]);
  assert.deepEqual(plan.matches.map((m) => (m as { invoice_id: string }).invoice_id), ["INV-0", "INV-80", "INV-160"]);
  assert.equal(plan.from_date, "2026-03-01");
  assert.equal(plan.to_date, "2026-03-20");
  assert.equal(plan.notice_template, "Dear {buyer}");
});

test("planRecall still calls the model once when there are no invoices", async () => {
  const { model, calls } = fakeModel(VALID);
  await planRecall(model, "recall", [], "2026-11-12");
  assert.equal(calls.length, 1);
  assert.deepEqual(userLines(calls[0].user), []);
});

test("planRecall puts the sentence and today's date in the prompts", async () => {
  const { model, calls } = fakeModel(VALID);
  await planRecall(model, "the timur achar may contain peanuts", many(1), "2026-11-12");
  assert.ok(calls[0].user.includes("the timur achar may contain peanuts"));
  assert.ok(calls[0].system.includes("2026-11-12"));
});

// candidates

test("candidates maps each line with a two decimal unit price", () => {
  const inv = invoice("INV-9", [line(0, { unitCents: 850 }), line(1, { name: "Gundruk", description: "greens", quantity: "1", unitCents: 700 })]);
  assert.deepEqual(candidates([inv]), [
    { invoice_id: "INV-9", invoice_date: "2026-03-05", line_index: 0, name: "Timur achar (jar, 250 g)", description: "Sichuan pepper pickle", quantity: "2", unit_price: "8.50" },
    { invoice_id: "INV-9", invoice_date: "2026-03-05", line_index: 1, name: "Gundruk", description: "greens", quantity: "1", unit_price: "7.00" },
  ]);
});

// openAiCompatModel

type Seen = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const cfg = { baseUrl: "https://api.example.test/openai/v1/", apiKey: "test-key", model: "m-1" };

test("openAiCompatModel posts the model, json mode and temperature 0 with a bearer key", async () => {
  const { fetchImpl, seen } = fakeFetch(() => Response.json({ choices: [{ message: { content: VALID } }] }));
  const model = openAiCompatModel(cfg, fetchImpl);
  const out = await model.complete("SYS", "USER");
  assert.equal(out, VALID);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.endsWith("/chat/completions"));
  assert.equal(seen[0].url, "https://api.example.test/openai/v1/chat/completions");
  assert.equal(seen[0].init.method, "POST");
  const headers = new Headers(seen[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(seen[0].init.body));
  assert.equal(body.model, "m-1");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.messages, [
    { role: "system", content: "SYS" },
    { role: "user", content: "USER" },
  ]);
});

test("openAiCompatModel labels itself with the host and the model", () => {
  const model = openAiCompatModel(cfg, fakeFetch(() => Response.json({})).fetchImpl);
  assert.equal(model.label, "api.example.test (m-1)");
});

test("openAiCompatModel returns an empty string when the reply has no content", async () => {
  const { fetchImpl } = fakeFetch(() => Response.json({ choices: [] }));
  assert.equal(await openAiCompatModel(cfg, fetchImpl).complete("s", "u"), "");
});

test("openAiCompatModel turns a 400 json_validate_failed into InvalidReplyError", async () => {
  const { fetchImpl } = fakeFetch(() => Response.json({ error: { code: "json_validate_failed", message: "bad json" } }, { status: 400 }));
  await assert.rejects(() => openAiCompatModel(cfg, fetchImpl).complete("s", "u"), InvalidReplyError);
});

test("openAiCompatModel throws a plain error for other failures", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("rate limited", { status: 429 }));
  await assert.rejects(
    () => openAiCompatModel(cfg, fetchImpl).complete("s", "u"),
    (err: Error) => !(err instanceof InvalidReplyError) && /model API 429: rate limited/.test(err.message),
  );
});

test("a 400 json_validate_failed from the model earns the planRecall retry", async () => {
  let n = 0;
  const { fetchImpl } = fakeFetch(() => (++n === 1 ? Response.json({ error: { code: "json_validate_failed" } }, { status: 400 }) : Response.json({ choices: [{ message: { content: VALID } }] })));
  const plan = await planRecall(openAiCompatModel(cfg, fetchImpl), "recall", many(1), "2026-11-12");
  assert.equal(n, 2);
  assert.equal(plan.product_phrase, "timur achar");
});

// whisperTranscriber

test("whisperTranscriber posts a multipart form with file and model and returns trimmed text", async () => {
  const { fetchImpl, seen } = fakeFetch(() => Response.json({ text: "  the timur achar is bad \n" }));
  const stt = whisperTranscriber({ ...cfg, sttModel: "whisper-test" }, fetchImpl);
  assert.equal(stt.label, "whisper-test");
  const text = await stt.transcribe(Buffer.from([1, 2, 3, 4]), "audio/webm;codecs=opus");
  assert.equal(text, "the timur achar is bad");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.example.test/openai/v1/audio/transcriptions");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(new Headers(seen[0].init.headers).get("authorization"), "Bearer test-key");
  const form = seen[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("model"), "whisper-test");
  const file = form.get("file") as File;
  assert.ok(file instanceof Blob);
  assert.equal(file.name, "note.webm");
  assert.equal(file.size, 4);
});

test("whisperTranscriber uses the default model and picks the file extension from the mime type", async () => {
  const { fetchImpl, seen } = fakeFetch(() => Response.json({ text: "ok" }));
  const stt = whisperTranscriber(cfg, fetchImpl);
  assert.equal(stt.label, "whisper-large-v3-turbo");
  await stt.transcribe(Buffer.from("a"), "audio/wav");
  assert.equal(((seen[0].init.body as FormData).get("file") as File).name, "note.wav");
  await stt.transcribe(Buffer.from("a"), "audio/mp4");
  assert.equal(((seen[1].init.body as FormData).get("file") as File).name, "note.m4a");
  assert.equal((seen[1].init.body as FormData).get("model"), "whisper-large-v3-turbo");
});

test("whisperTranscriber throws on a non-2xx answer", async () => {
  const { fetchImpl } = fakeFetch(() => new Response("bad audio", { status: 400 }));
  await assert.rejects(() => whisperTranscriber(cfg, fetchImpl).transcribe(Buffer.from("a"), "audio/wav"), /speech API 400: bad audio/);
});
