import express, { type ErrorRequestHandler } from "express";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { candidates, InvalidReplyError, planRecall, type Model, type Transcriber } from "./agent.js";
import { PayPalError, type Gateway, type Invoice, type Trace } from "./gateway.js";
import { checkExecute, decide, formatUsd, squash, type Action, type Decision, type ModelPlan } from "./rules.js";
import { SAMPLE_SENTENCE } from "./seed-data.js";

export const MAX_SENTENCE = 400;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

type LogLine = { at: string; event: string; detail: string };
type Result = { state: "done" | "already done" | "failed"; paypalId: string | null; error: string | null; at: string };
type Recall = {
  id: string;
  sentence: string;
  transcript: string | null;
  plan: ModelPlan;
  decision: Decision;
  results: Map<string, Result>;
  executions: number;
};
type LedgerEntry = { recallId: string; action: Action; paypalId: string; at: string };

export type AppDeps = { gateway: Gateway; model: Model | null; transcriber?: Transcriber | null; today?: () => string; ledgerFile?: string | null };

const PAYPAL_WEB = "https://www.sandbox.paypal.com/invoice/details/";

export function createApp({ gateway, model, transcriber = null, today = () => new Date().toISOString().slice(0, 10), ledgerFile = null }: AppDeps) {
  const recalls = new Map<string, Recall>();
  // Recalls stay in memory. The ledger of done actions is also written to ledgerFile when one is set,
  // so a restart does not refund a line again.
  const ledger = new Map<string, LedgerEntry>();
  const refundedItems = new Set<string>();
  if (ledgerFile && existsSync(ledgerFile)) {
    for (const e of JSON.parse(readFileSync(ledgerFile, "utf8")) as LedgerEntry[]) {
      ledger.set(e.action.key, e);
      if (e.action.kind === "refund_line") refundedItems.add(e.action.itemId);
    }
  }
  const saveLedger = () => {
    if (ledgerFile) writeFileSync(ledgerFile, JSON.stringify([...ledger.values()], null, 1));
  };
  const busy = new Set<string>();
  const plans = new Map<string, ModelPlan>();
  const serverLog: LogLine[] = [];

  const log = (event: string, detail: string) => {
    const line = { at: new Date().toISOString(), event, detail };
    serverLog.push(line);
    if (serverLog.length > 600) serverLog.splice(0, serverLog.length - 600);
    console.log(JSON.stringify({ mode: gateway.mode, ...line }));
  };
  const trace: Trace = (c) => log("paypal.call", `${c.method} ${c.path.split("?")[0]} -> ${c.status} in ${c.ms} ms`);
  const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const webUrl = (id: string) => (gateway.mode === "sandbox" ? PAYPAL_WEB + encodeURIComponent(id) : null);

  const actionView = (a: Action, r?: Result) => ({
    ...a,
    amount: formatUsd(a.amountCents),
    result: r?.state ?? null,
    paypalId: r?.paypalId ?? null,
    error: r?.error ?? null,
    invoiceUrl: webUrl(a.invoiceId),
  });

  const summary = (d: Decision) => {
    const count = (k: string) => d.actions.filter((a) => a.kind === k).length;
    return {
      refunds: count("refund_line"),
      pulled: count("pull_line"),
      drafts: count("edit_draft_line"),
      refused: count("refused") + count("skipped"),
      refundTotal: formatUsd(d.refundCents),
      refundCents: d.refundCents,
    };
  };

  const recallView = (r: Recall) => ({
    mode: gateway.mode,
    id: r.id,
    sentence: r.sentence,
    transcript: r.transcript,
    product: r.plan.product_phrase,
    hazard: r.plan.hazard,
    window: r.decision.window,
    planHash: r.decision.hash,
    templateRejected: r.decision.templateRejected,
    executions: r.executions,
    summary: summary(r.decision),
    actions: r.decision.actions.map((a) => actionView(a, r.results.get(a.key))),
    log: serverLog.slice(-200),
  });

  const loadInvoices = async () => {
    const invoices = await gateway.listDemo(trace);
    log("paypal.read", `${invoices.length} demo invoices with reference lot-recall-demo`);
    return invoices;
  };

  function replan(r: Recall, invoices: Invoice[]): Decision {
    const d = decide({ recallId: r.id, plan: r.plan, invoices, refundedItems });
    for (const a of d.actions) log(`rule.${a.kind}`, `${a.number} line ${a.lineIndex + 1} "${a.item}": ${a.reason}${a.amountCents ? `, ${formatUsd(a.amountCents)}` : ""}`);
    if (d.templateRejected) log("rule.notice", "the model notice named an amount or was empty; the server template is used");
    return d;
  }

  const app = express();
  app.use(express.json({ limit: "12mb" }));
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/config", (_req, res) => {
    res.json({ mode: gateway.mode, model: model?.label ?? null, speech: transcriber?.label ?? null, sample: SAMPLE_SENTENCE, maxSentence: MAX_SENTENCE });
  });

  app.get("/api/seed-status", async (_req, res) => {
    try {
      const invoices = await loadInvoices();
      const byStatus: Record<string, number> = {};
      for (const inv of invoices) byStatus[inv.status] = (byStatus[inv.status] ?? 0) + 1;
      res.json({ mode: gateway.mode, count: invoices.length, byStatus });
    } catch (err) {
      log("paypal.error", describe(err));
      res.status(502).json({ error: "PayPal did not return the demo invoices. Check the sandbox keys and try again." });
    }
  });

  app.post("/api/recalls/preview", async (req, res) => {
    let sentence: unknown = req.body?.sentence;
    let transcript: string | null = null;
    const audio: unknown = req.body?.audioBase64;
    if (typeof audio === "string" && audio) {
      if (!transcriber) {
        res.status(503).json({ error: "No speech model is configured. Type the recall sentence instead." });
        return;
      }
      const bytes = Buffer.from(audio, "base64");
      if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) {
        res.status(413).json({ error: "The voice note must be between 1 byte and 8 MB. Record a shorter note." });
        return;
      }
      try {
        const vocabulary = await gateway
          .listDemo(trace)
          .then((invs) => [...new Set(invs.flatMap((i) => i.lines.map((l) => l.name.replace(/\s*\(.*\)$/, ""))))])
          .catch(() => []);
        transcript = await transcriber.transcribe(bytes, String(req.body?.audioType || "audio/wav"), vocabulary);
        log("speech.transcript", `${bytes.length} bytes -> "${transcript}"`);
      } catch (err) {
        log("speech.error", describe(err));
        res.status(502).json({ error: "The speech model could not read the voice note. Try again or type the sentence." });
        return;
      }
      sentence = transcript;
    }
    if (typeof sentence !== "string" || !squash(sentence)) {
      res.status(400).json({ error: "The recall sentence is empty. Name the product, the dates and the problem.", transcript });
      return;
    }
    const text = squash(sentence);
    if (text.length > MAX_SENTENCE) {
      res.status(413).json({ error: `The recall sentence is longer than ${MAX_SENTENCE} characters. Write one sentence with the product, the dates and the problem.`, transcript });
      return;
    }
    if (!model) {
      res.status(503).json({ error: "No AI model is configured. Set AI_API_KEY in .env and start the server again." });
      return;
    }
    const id = `R-${createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 10)}`;
    if (busy.has(id)) {
      res.status(409).json({ error: "This recall is running. Wait for it to finish." });
      return;
    }
    log("recall.preview", `${id}: "${text}"`);
    let invoices: Invoice[];
    try {
      invoices = await loadInvoices();
    } catch (err) {
      log("paypal.error", describe(err));
      res.status(502).json({ error: "PayPal did not return the invoices. Check the sandbox keys and try again.", transcript });
      return;
    }
    let plan: ModelPlan;
    // Same sentence and the same invoice lines give the same question, so the last answer is reused.
    const cacheKey = `${id}:${createHash("sha256").update(JSON.stringify(candidates(invoices))).digest("hex")}`;
    try {
      const cached = plans.get(cacheKey);
      if (cached) log("model.cache", "same sentence and same invoice lines: the earlier model answer is reused");
      plan = cached ?? (await planRecall(model, text, invoices, today(), log));
      plans.set(cacheKey, plan);
    } catch (err) {
      log("model.error", describe(err));
      const bad = err instanceof InvalidReplyError;
      res.status(502).json({ error: bad ? "The AI model did not return a valid plan two times. Try again." : "The AI model call failed. Try again.", transcript });
      return;
    }
    log("model.plan", `product "${plan.product_phrase}", ${plan.from_date} to ${plan.to_date}, ${plan.matches.length} matches`);
    const old = recalls.get(id);
    const r: Recall = { id, sentence: text, transcript, plan, decision: { ok: false, error: null, actions: [], refundCents: 0, hash: "", window: null, templateRejected: false }, results: old?.results ?? new Map(), executions: old?.executions ?? 0 };
    r.decision = replan(r, invoices);
    if (!r.decision.ok) {
      log("rule.stop", r.decision.error ?? "");
      res.status(422).json({ error: r.decision.error, transcript, mode: gateway.mode, log: serverLog.slice(-200) });
      return;
    }
    // Lines a run of this recall already handled stay marked done.
    for (const a of r.decision.actions) {
      const done = ledger.get(a.key);
      if (a.kind === "refused" || a.kind === "skipped") r.results.delete(a.key);
      else if (done && !r.results.has(a.key)) r.results.set(a.key, { state: "done", paypalId: done.paypalId, error: null, at: done.at });
    }
    recalls.set(id, r);
    log("recall.dry_run", `${id}: hash ${r.decision.hash}, ${JSON.stringify(summary(r.decision))}`);
    res.json(recallView(r));
  });

  app.post("/api/recalls/:id/execute", async (req, res) => {
    const r = recalls.get(req.params.id);
    if (!r) {
      res.status(404).json({ error: "This recall is not on the server. The server keeps recalls in memory. Preview it again." });
      return;
    }
    const check = checkExecute(r.decision.hash, req.body?.planHash, req.body?.confirm);
    if (!check.ok) {
      log("rule.execute_refused", check.error);
      res.status(check.status).json({ error: check.error });
      return;
    }
    if (busy.has(r.id)) {
      res.status(409).json({ error: "This recall is running. Wait for it to finish." });
      return;
    }
    busy.add(r.id);
    try {
      const work = r.decision.actions.filter((a) => a.kind !== "refused" && a.kind !== "skipped");
      const allDone = work.every((a) => ledger.has(a.key));
      if (!allDone) {
        let invoices: Invoice[];
        try {
          invoices = await loadInvoices();
        } catch (err) {
          log("paypal.error", describe(err));
          res.status(502).json({ error: "PayPal did not return the invoices. Nothing ran. Try again." });
          return;
        }
        // Lines already done drop out of a fresh plan, so the check only runs before the first action.
        if (!work.some((a) => ledger.has(a.key))) {
          const fresh = decide({ recallId: r.id, plan: r.plan, invoices, refundedItems });
          if (fresh.hash !== r.decision.hash) {
            r.decision = fresh.ok ? fresh : r.decision;
            log("rule.stale", `PayPal data changed since the dry run. New hash ${fresh.hash}`);
            res.status(409).json({ ...recallView(r), error: "PayPal data changed since the dry run, for example an invoice was paid. Nothing ran. Review the new dry run and confirm again." });
            return;
          }
        }
      }
      r.executions++;
      log("recall.execute", `${r.id}: run ${r.executions}, ${work.length} actions`);
      for (const a of work) {
        const prior = ledger.get(a.key);
        if (prior) {
          r.results.set(a.key, { state: "already done", paypalId: prior.paypalId, error: null, at: new Date().toISOString() });
          log("ledger.skip", `${a.number} "${a.item}": already done (${prior.paypalId})`);
          continue;
        }
        try {
          let paypalId = a.invoiceId;
          if (a.kind === "refund_line") {
            // Probe: PayPal did not drop a refund replayed with this request id and a new amount.
            // The ledger file is the guard against a second refund, also after a restart.
            paypalId = await gateway.refund(a.invoiceId, a.amountCents, today(), `lr-refund-${a.invoiceId}-${a.itemId}`, trace);
            refundedItems.add(a.itemId);
          } else {
            await gateway.removeLine(a.invoiceId, a.itemId, `lr-edit-${a.invoiceId}-${a.itemId}`, trace);
          }
          const at = new Date().toISOString();
          ledger.set(a.key, { recallId: r.id, action: a, paypalId, at });
          saveLedger();
          r.results.set(a.key, { state: "done", paypalId, error: null, at });
          log(`action.${a.kind}`, `${a.number} "${a.item}" ${formatUsd(a.amountCents)} -> ${paypalId}`);
        } catch (err) {
          const msg = err instanceof PayPalError ? `PayPal refused (${err.issue}). Open the invoice in PayPal to check it.` : "PayPal did not answer. Run the recall again to retry this line.";
          r.results.set(a.key, { state: "failed", paypalId: null, error: msg, at: new Date().toISOString() });
          log("action.error", `${a.number} "${a.item}": ${describe(err)}`);
        }
      }
      res.json(recallView(r));
    } finally {
      busy.delete(r.id);
    }
  });

  // Live status for each invoice the recall touched.
  app.get("/api/recalls/:id", async (req, res) => {
    const r = recalls.get(req.params.id);
    if (!r) {
      res.status(404).json({ error: "This recall is not on the server. The server keeps recalls in memory. Preview it again." });
      return;
    }
    const ids = [...new Set(r.decision.actions.map((a) => a.invoiceId))];
    const live: Record<string, { status: string; paid: string; refunded: string; lines: number }> = {};
    await Promise.all(
      ids.map(async (id) => {
        try {
          const inv = await gateway.get(id, trace);
          live[id] = { status: inv.status, paid: formatUsd(inv.paidCents), refunded: formatUsd(inv.refundedCents), lines: inv.lines.length };
        } catch (err) {
          log("paypal.error", `${id}: ${describe(err)}`);
        }
      }),
    );
    res.json({ ...recallView(r), live });
  });

  app.get("/api/ledger", async (_req, res) => {
    const rows = [...ledger.values()];
    const live = new Map<string, string>();
    await Promise.all(
      [...new Set(rows.map((e) => e.action.invoiceId))].map(async (id) => {
        try {
          live.set(id, (await gateway.get(id, trace)).status);
        } catch {
          live.set(id, "UNKNOWN");
        }
      }),
    );
    res.json({
      mode: gateway.mode,
      entries: rows.map((e) => ({ recallId: e.recallId, number: e.action.number, item: e.action.item, kind: e.action.kind, amount: formatUsd(e.action.amountCents), paypalId: e.paypalId, at: e.at, status: live.get(e.action.invoiceId) })),
    });
  });

  app.get("/api/log", (_req, res) => {
    res.json({ log: serverLog.slice(-200) });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === "number" ? err.status : 0;
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: status === 413 ? "The request is too large. Use a voice note under 8 MB." : "The request body is not valid JSON." });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "The server failed. Try again." });
  };
  app.use(onError);

  return app;
}
