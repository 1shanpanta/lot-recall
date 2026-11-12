import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { Model } from "../src/agent.js";
import { PayPalError, mockGateway, type Gateway } from "../src/gateway.js";
import { SEED } from "../src/seed-data.js";
import { createApp } from "../src/server.js";

// The server logs one JSON line per event. Keep the test output clean.
mock.method(console, "log", () => {});

const SENTENCE = "The timur achar made between March 1 and March 20 may contain peanuts.";
const RECALLED = "Timur achar (jar, 250 g)";
const LOOKALIKE = "Timur salt (pouch, 100 g)";

const seedGateway = () => mockGateway(SEED.map((s) => s.invoice), SEED.map((s) => s.state));

// Reads the JSON lines after the two header lines of the user prompt and answers like a model would.
function fakeModel(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const model: Model = {
    label: "fake-model",
    async complete(_system, user) {
      calls.push(user);
      const lines = user
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { invoice_id: string; line_index: number; name: string });
      const matches = lines
        .filter((l) => l.name === RECALLED || l.name === LOOKALIKE)
        .map((l) => ({
          invoice_id: l.invoice_id,
          line_index: l.line_index,
          quote: l.name,
          verdict: l.name === RECALLED ? "recalled" : "lookalike",
          reason: l.name === RECALLED ? "same product" : "salt, not the pickle",
        }));
      return JSON.stringify({
        product_phrase: "timur achar",
        from_date: "2026-03-01",
        to_date: "2026-03-20",
        hazard: "may contain peanuts",
        matches,
        notice_template: "Dear {buyer}, we recall {item} from order {order}. {refund}",
        ...over,
      });
    },
  };
  return { model, calls };
}

async function serve(model: Model | null, gateway: Gateway = seedGateway(), ledgerFile: string | null = null) {
  const app = createApp({ gateway, model, today: () => "2026-11-12", ledgerFile });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, raw?: string) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return {
    gateway,
    preview: (sentence: unknown = SENTENCE) => call("POST", "/api/recalls/preview", { sentence }),
    execute: (id: string, body: unknown) => call("POST", `/api/recalls/${id}/execute`, body),
    post: (path: string, body: unknown, raw?: string) => call("POST", path, body, raw),
    get: (path: string) => call("GET", path),
    close: () => server.close(),
  };
}

const isWork = (a: { kind: string }) => a.kind === "refund_line" || a.kind === "pull_line" || a.kind === "edit_draft_line";

// config and input checks

test("GET /api/config reports mock mode, the model label and the limits", async () => {
  const app = await serve(fakeModel().model);
  try {
    const r = await app.get("/api/config");
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, "mock");
    assert.equal(r.body.model, "fake-model");
    assert.equal(r.body.speech, null);
    assert.equal(r.body.maxSentence, 400);
    assert.equal(typeof r.body.sample, "string");
  } finally {
    app.close();
  }
});

test("GET /health answers ok", async () => {
  const app = await serve(null);
  try {
    assert.deepEqual((await app.get("/health")).body, { ok: true });
  } finally {
    app.close();
  }
});

test("preview with an empty or blank sentence answers 400", async () => {
  const { model, calls } = fakeModel();
  const app = await serve(model);
  try {
    for (const sentence of ["", "   \n ", null, 42]) {
      const r = await app.post("/api/recalls/preview", { sentence });
      assert.equal(r.status, 400, String(sentence));
      assert.match(r.body.error, /empty/);
    }
    assert.equal(calls.length, 0);
  } finally {
    app.close();
  }
});

test("preview with a sentence over 400 characters answers 413", async () => {
  const { model, calls } = fakeModel();
  const app = await serve(model);
  try {
    const r = await app.preview("a".repeat(401));
    assert.equal(r.status, 413);
    assert.match(r.body.error, /longer than 400/);
    assert.equal((await app.preview("a".repeat(400))).status, 200);
    assert.equal(calls.length, 1);
  } finally {
    app.close();
  }
});

test("preview with no model configured answers 503", async () => {
  const app = await serve(null);
  try {
    const r = await app.preview();
    assert.equal(r.status, 503);
    assert.match(r.body.error, /No AI model/);
  } finally {
    app.close();
  }
});

test("a body that is not valid JSON answers 400 with a plain error", async () => {
  const app = await serve(fakeModel().model);
  try {
    const r = await app.post("/api/recalls/preview", undefined, "{not json");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not valid JSON/);
  } finally {
    app.close();
  }
});

test("audio with no speech model configured answers 503", async () => {
  const app = await serve(fakeModel().model);
  try {
    const r = await app.post("/api/recalls/preview", { audioBase64: Buffer.from("abc").toString("base64") });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /speech model/);
  } finally {
    app.close();
  }
});

// preview

test("preview returns the dry run: 9 refunds, 3 pulled, 2 drafts, 4 refused", async () => {
  const { model, calls } = fakeModel();
  const app = await serve(model);
  try {
    const r = await app.preview();
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, "mock");
    assert.match(r.body.id, /^R-[0-9a-f]{10}$/);
    assert.equal(r.body.product, "timur achar");
    assert.deepEqual(r.body.window, { from: "2026-03-01", to: "2026-03-20" });
    assert.match(r.body.planHash, /^[0-9a-f]{16}$/);
    assert.equal(r.body.templateRejected, false);
    assert.equal(r.body.summary.refunds, 9);
    assert.equal(r.body.summary.pulled, 3);
    assert.equal(r.body.summary.drafts, 2);
    assert.equal(r.body.summary.refused, 4);
    assert.ok(r.body.summary.refundCents > 0);
    assert.match(r.body.summary.refundTotal, /^\$\d/);
    assert.equal(r.body.actions.length, 18);
    assert.equal(calls.length, 1);
    const refused = r.body.actions.filter((a: any) => a.kind === "refused");
    assert.deepEqual(refused.map((a: any) => a.reason).sort(), ["lookalike: salt, not the pickle", "lookalike: salt, not the pickle", "outside the recall dates", "outside the recall dates"]);
    assert.ok(r.body.actions.filter(isWork).every((a: any) => a.result === null && typeof a.notice === "string" && a.notice.includes(a.number)));
    const refund = r.body.actions.find((a: any) => a.kind === "refund_line");
    assert.match(refund.amount, /^\$\d+\.\d{2}$/);
    assert.equal(refund.invoiceUrl, null);
  } finally {
    app.close();
  }
});

test("preview works when the model lists only some of the recalled lines", async () => {
  const { model } = fakeModel();
  const partial: Model = {
    label: "partial",
    async complete(system, user) {
      const plan = JSON.parse(await model.complete(system, user));
      plan.matches = plan.matches.filter((m: any) => m.verdict === "recalled").slice(0, 1);
      return JSON.stringify(plan);
    },
  };
  const app = await serve(partial);
  try {
    const r = await app.preview();
    assert.equal(r.status, 200);
    assert.equal(r.body.summary.refunds, 9);
    assert.equal(r.body.summary.pulled, 3);
    assert.equal(r.body.summary.drafts, 2);
    assert.ok(r.body.actions.some((a: any) => a.source === "name sweep"));
  } finally {
    app.close();
  }
});

test("preview with a notice template that names an amount reports templateRejected", async () => {
  const app = await serve(fakeModel({ notice_template: "Dear {buyer}, here is $5 off {item}." }).model);
  try {
    const r = await app.preview();
    assert.equal(r.body.templateRejected, true);
    assert.ok(r.body.actions.filter(isWork).every((a: any) => !a.notice.includes("$5 off")));
  } finally {
    app.close();
  }
});

test("preview answers 422 when the model dates are not valid", async () => {
  const app = await serve(fakeModel({ from_date: "2026-02-30" }).model);
  try {
    const r = await app.preview();
    assert.equal(r.status, 422);
    assert.match(r.body.error, /not valid dates/);
  } finally {
    app.close();
  }
});

test("preview answers 502 when the model returns invalid JSON twice", async () => {
  const model: Model = { label: "bad", complete: async () => "not json" };
  const app = await serve(model);
  try {
    const r = await app.preview();
    assert.equal(r.status, 502);
    assert.match(r.body.error, /valid plan two times/);
  } finally {
    app.close();
  }
});

test("preview answers 502 when PayPal cannot list the invoices", async () => {
  const gateway: Gateway = { ...seedGateway(), listDemo: async () => Promise.reject(new PayPalError(401, "AUTHENTICATION_FAILURE", "dbg")) };
  const app = await serve(fakeModel().model, gateway);
  try {
    const r = await app.preview();
    assert.equal(r.status, 502);
    assert.match(r.body.error, /PayPal did not return the invoices/);
  } finally {
    app.close();
  }
});

test("GET /api/seed-status counts the demo invoices by status", async () => {
  const app = await serve(null);
  try {
    const r = await app.get("/api/seed-status");
    assert.equal(r.body.count, 18);
    assert.deepEqual(r.body.byStatus, { MARKED_AS_PAID: 12, UNPAID: 4, DRAFT: 2 });
  } finally {
    app.close();
  }
});

// execute

test("execute without confirm answers 400", async () => {
  const app = await serve(fakeModel().model);
  try {
    const p = await app.preview();
    for (const body of [{ planHash: p.body.planHash }, { planHash: p.body.planHash, confirm: "true" }, {}]) {
      const r = await app.execute(p.body.id, body);
      assert.equal(r.status, 400);
    }
    assert.equal((await app.get("/api/ledger")).body.entries.length, 0);
  } finally {
    app.close();
  }
});

test("execute with the wrong hash answers 409 and runs nothing", async () => {
  const app = await serve(fakeModel().model);
  try {
    const p = await app.preview();
    const r = await app.execute(p.body.id, { planHash: "0000000000000000", confirm: true });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not the dry run on screen/);
    assert.equal((await app.get("/api/ledger")).body.entries.length, 0);
  } finally {
    app.close();
  }
});

test("execute with an unknown recall id answers 404", async () => {
  const app = await serve(fakeModel().model);
  try {
    const r = await app.execute("R-unknown", { planHash: "x", confirm: true });
    assert.equal(r.status, 404);
  } finally {
    app.close();
  }
});

test("execute with the right hash does every work action", async () => {
  const app = await serve(fakeModel().model);
  try {
    const p = await app.preview();
    const r = await app.execute(p.body.id, { planHash: p.body.planHash, confirm: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.executions, 1);
    const work = r.body.actions.filter(isWork);
    assert.equal(work.length, 14);
    assert.ok(work.every((a: any) => a.result === "done" && a.paypalId), "every work action is done");
    assert.ok(r.body.actions.filter((a: any) => !isWork(a)).every((a: any) => a.result === null));
    for (const a of work) {
      const inv = await app.gateway.get(a.invoiceId);
      if (a.kind === "refund_line") {
        assert.ok(inv.refundedCents > 0, `${a.number} refunded`);
        assert.match(a.paypalId, /^MOCKREF-/);
      } else {
        assert.ok(!inv.lines.some((l) => l.itemId === a.itemId), `${a.number} line gone`);
      }
    }
  } finally {
    app.close();
  }
});

test("a second execute with the same hash reports already done and refunds nothing more", async () => {
  const app = await serve(fakeModel().model);
  try {
    const p = await app.preview();
    const body = { planHash: p.body.planHash, confirm: true };
    await app.execute(p.body.id, body);
    const refunded = async () => (await app.gateway.listDemo()).map((i) => i.refundedCents);
    const before = await refunded();
    const r = await app.execute(p.body.id, body);
    assert.equal(r.status, 200);
    assert.ok(r.body.actions.filter(isWork).every((a: any) => a.result === "already done"));
    assert.deepEqual(await refunded(), before);
  } finally {
    app.close();
  }
});

test("the ledger file survives a restart: a new server refunds nothing again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lr-ledger-"));
  const file = join(dir, "ledger.json");
  const gateway = seedGateway();
  try {
    const first = await serve(fakeModel().model, gateway, file);
    const p = await first.preview();
    await first.execute(p.body.id, { planHash: p.body.planHash, confirm: true });
    first.close();
    const before = (await gateway.listDemo()).map((i) => i.refundedCents);
    // Same PayPal data, new process memory: only the file remembers the refunds.
    const second = await serve(fakeModel().model, gateway, file);
    try {
      const again = await second.preview();
      assert.equal(again.body.summary.refunds, 0);
      assert.equal(again.body.actions.filter((a: any) => a.reason === "already refunded").length, 9);
      await second.execute(again.body.id, { planHash: again.body.planHash, confirm: true });
      assert.deepEqual((await gateway.listDemo()).map((i) => i.refundedCents), before);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preview after execute skips the paid lines as already refunded and execute refunds nothing new", async () => {
  const app = await serve(fakeModel().model);
  try {
    const first = await app.preview();
    await app.execute(first.body.id, { planHash: first.body.planHash, confirm: true });
    const before = (await app.gateway.listDemo()).map((i) => i.refundedCents);
    const again = await app.preview();
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
    const skipped = again.body.actions.filter((a: any) => a.kind === "skipped");
    assert.equal(skipped.length, 9);
    assert.ok(skipped.every((a: any) => a.reason === "already refunded"));
    assert.equal(again.body.summary.refunds, 0);
    const r = await app.execute(again.body.id, { planHash: again.body.planHash, confirm: true });
    assert.equal(r.status, 200);
    assert.deepEqual((await app.gateway.listDemo()).map((i) => i.refundedCents), before);
  } finally {
    app.close();
  }
});

test("a line that PayPal refuses is marked failed and the other lines still run", async () => {
  const real = seedGateway();
  const gateway: Gateway = { ...real, refund: async () => Promise.reject(new PayPalError(422, "REFUND_AMOUNT_EXCEEDED", "dbg")) };
  const app = await serve(fakeModel().model, gateway);
  try {
    const p = await app.preview();
    const r = await app.execute(p.body.id, { planHash: p.body.planHash, confirm: true });
    assert.equal(r.status, 200);
    const refunds = r.body.actions.filter((a: any) => a.kind === "refund_line");
    assert.ok(refunds.every((a: any) => a.result === "failed" && /REFUND_AMOUNT_EXCEEDED/.test(a.error)));
    assert.ok(r.body.actions.filter((a: any) => a.kind === "pull_line" || a.kind === "edit_draft_line").every((a: any) => a.result === "done"));
    assert.equal((await app.get("/api/ledger")).body.entries.length, 5);
  } finally {
    app.close();
  }
});

test("a stale plan answers 409 mentioning the change, runs nothing and can be confirmed again", async () => {
  const app = await serve(fakeModel().model);
  try {
    const p = await app.preview();
    const pulled = p.body.actions.find((a: any) => a.kind === "pull_line");
    const inv = await app.gateway.get(pulled.invoiceId);
    await app.gateway.recordPayment(inv.id, inv.totalCents, "2026-11-12");
    const r = await app.execute(p.body.id, { planHash: p.body.planHash, confirm: true });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /changed/);
    assert.notEqual(r.body.planHash, p.body.planHash);
    assert.equal((await app.get("/api/ledger")).body.entries.length, 0);
    assert.ok((await app.gateway.listDemo()).every((i) => i.refundedCents === 0));
    const retry = await app.execute(p.body.id, { planHash: r.body.planHash, confirm: true });
    assert.equal(retry.status, 200);
    assert.ok(retry.body.actions.filter(isWork).every((a: any) => a.result === "done"));
    const paidNow = retry.body.actions.find((a: any) => a.invoiceId === inv.id && isWork(a));
    assert.equal(paidNow.kind, "refund_line");
  } finally {
    app.close();
  }
});

// reads

test("GET /api/recalls/:id returns live statuses for the touched invoices", async () => {
  const app = await serve(fakeModel().model);
  try {
    const p = await app.preview();
    await app.execute(p.body.id, { planHash: p.body.planHash, confirm: true });
    const r = await app.get(`/api/recalls/${p.body.id}`);
    assert.equal(r.status, 200);
    const refund = r.body.actions.find((a: any) => a.kind === "refund_line");
    const pulled = r.body.actions.find((a: any) => a.kind === "pull_line");
    assert.match(r.body.live[refund.invoiceId].status, /REFUNDED$/);
    assert.match(r.body.live[refund.invoiceId].refunded, /^\$[1-9]/);
    assert.equal(r.body.live[pulled.invoiceId].status, "SENT");
    assert.equal(r.body.live[pulled.invoiceId].lines, 1);
    assert.equal(Object.keys(r.body.live).length, new Set(r.body.actions.map((a: any) => a.invoiceId)).size);
  } finally {
    app.close();
  }
});

test("GET /api/recalls/:id answers 404 for an unknown id", async () => {
  const app = await serve(fakeModel().model);
  try {
    const r = await app.get("/api/recalls/R-nope");
    assert.equal(r.status, 404);
    assert.match(r.body.error, /not on the server/);
  } finally {
    app.close();
  }
});

test("GET /api/ledger lists every done entry with its live status", async () => {
  const app = await serve(fakeModel().model);
  try {
    assert.deepEqual((await app.get("/api/ledger")).body.entries, []);
    const p = await app.preview();
    await app.execute(p.body.id, { planHash: p.body.planHash, confirm: true });
    const r = await app.get("/api/ledger");
    assert.equal(r.body.mode, "mock");
    assert.equal(r.body.entries.length, 14);
    assert.deepEqual(
      ["refund_line", "pull_line", "edit_draft_line"].map((k) => r.body.entries.filter((e: any) => e.kind === k).length),
      [9, 3, 2],
    );
    assert.ok(r.body.entries.every((e: any) => e.recallId === p.body.id && e.paypalId && e.status));
  } finally {
    app.close();
  }
});

test("GET /api/log returns the server log with the recall events", async () => {
  const app = await serve(fakeModel().model);
  try {
    await app.preview();
    const r = await app.get("/api/log");
    const events = r.body.log.map((l: { event: string }) => l.event);
    for (const event of ["recall.preview", "model.plan", "recall.dry_run"]) assert.ok(events.includes(event), event);
  } finally {
    app.close();
  }
});
