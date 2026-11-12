import assert from "node:assert/strict";
import { test } from "node:test";
import { SEED_SET, SEED_TAG, PayPalError, isDemo, mockGateway, parseInvoice, paypalSandboxGateway, toCents, type Call } from "../src/gateway.js";
import { SEED } from "../src/seed-data.js";

type Seen = { method: string; path: string; headers: Record<string, string>; body: any };

const BASE = "https://paypal.test";
const ID = "INV2-0001";
const money = (value: string) => ({ currency_code: "USD", value });

// A GET body shaped like the sandbox answer, with fields PayPal computes (amount, links, item ids).
const rawInvoice = (id = ID, over: Record<string, unknown> = {}) => ({
  id,
  status: "PAID",
  detail: { invoice_number: "0001", invoice_date: "2026-03-05", note: `Order. Demo data (${SEED_TAG}${SEED_SET}01).`, reference: "lot-recall-demo", currency_code: "USD", metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#X" } },
  invoicer: { business_name: "Himal Pickles" },
  primary_recipients: [{ billing_info: { name: { given_name: "Asha", surname: "Gurung", full_name: "Asha Gurung" }, email_address: "asha@example.com" } }],
  items: [
    { id: "ITEM-A", name: "Timur achar (jar, 250 g)", description: "Sichuan pepper pickle", quantity: "2", unit_amount: money("8.50"), tax: { name: "VAT", percent: "10.0", amount: money("1.70") }, unit_of_measure: "QUANTITY" },
    { id: "ITEM-B", name: "Gundruk achar (jar, 250 g)", description: "Fermented greens", quantity: "1", unit_amount: money("7.00"), unit_of_measure: "QUANTITY" },
  ],
  amount: { currency_code: "USD", value: "25.70", breakdown: {} },
  due_amount: money("0.00"),
  payments: { paid_amount: money("25.70") },
  refunds: { refund_amount: money("5.00") },
  links: [{ rel: "self", href: "x" }],
  ...over,
});

// Records every call. A handler per "METHOD /path" overrides the defaults.
function fakePayPal(handlers: Record<string, (seen: Seen) => Response> = {}, tokenTtl = 3600) {
  const seen: Seen[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? init.body : "";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Seen = { method, path: url.slice(BASE.length), headers, body: raw.startsWith("{") ? JSON.parse(raw) : raw };
    seen.push(call);
    const handler = handlers[`${method} ${call.path.split("?")[0]}`];
    if (handler) return handler(call);
    if (call.path === "/v1/oauth2/token") return json({ access_token: `tok-${seen.filter((s) => s.path === "/v1/oauth2/token").length}`, expires_in: tokenTtl });
    if (method === "GET" && call.path === `/v2/invoicing/invoices/${ID}`) return json(rawInvoice());
    if (method === "POST" && call.path === `/v2/invoicing/invoices/${ID}/refunds`) return json({ refund_id: "REF-1" });
    if (method === "POST" && call.path === `/v2/invoicing/invoices/${ID}/payments`) return json({ payment_id: "PAY-1" });
    if (method === "PUT") return json({});
    return json({ name: "RESOURCE_NOT_FOUND", debug_id: "dbg-404" }, 404);
  }) as typeof fetch;
  return { fetchImpl, seen, gateway: () =>paypalSandboxGateway("cid", "secret", fetchImpl, BASE) };
}

const tokenCalls = (seen: Seen[]) => seen.filter((s) => s.path === "/v1/oauth2/token");

// token

test("the token is fetched once with basic auth and reused", async () => {
  const { gateway, seen } = fakePayPal();
  const gw = gateway();
  await gw.get(ID);
  await gw.get(ID);
  assert.equal(tokenCalls(seen).length, 1);
  assert.equal(seen[0].headers.authorization, `Basic ${Buffer.from("cid:secret").toString("base64")}`);
  assert.equal(seen[0].body, "grant_type=client_credentials");
  assert.deepEqual(seen.filter((s) => s.method === "GET").map((s) => s.headers.authorization), ["Bearer tok-1", "Bearer tok-1"]);
});

test("a token that expires within a minute is fetched again", async () => {
  const { gateway, seen } = fakePayPal({}, 30);
  const gw = gateway();
  await gw.get(ID);
  await gw.get(ID);
  assert.equal(tokenCalls(seen).length, 2);
});

// refund and payment

test("refund posts BANK_TRANSFER with the amount and the request id", async () => {
  const { gateway, seen } = fakePayPal();
  const refundId = await gateway().refund(ID, 1870, "2026-11-12", "lr-refund-INV-ITEM");
  assert.equal(refundId, "REF-1");
  const post = seen.find((s) => s.path === `/v2/invoicing/invoices/${ID}/refunds`)!;
  assert.equal(post.method, "POST");
  assert.deepEqual(post.body, { method: "BANK_TRANSFER", refund_date: "2026-11-12", amount: { currency_code: "USD", value: "18.70" } });
  assert.equal(post.headers["paypal-request-id"], "lr-refund-INV-ITEM");
  assert.equal(post.headers.authorization, "Bearer tok-1");
});

test("recordPayment posts an external BANK_TRANSFER payment", async () => {
  const { gateway, seen } = fakePayPal();
  await gateway().recordPayment(ID, 2570, "2026-03-05");
  const post = seen.find((s) => s.path === `/v2/invoicing/invoices/${ID}/payments`)!;
  assert.equal(post.method, "POST");
  assert.equal(post.body.method, "BANK_TRANSFER");
  assert.equal(post.body.payment_date, "2026-03-05");
  assert.deepEqual(post.body.amount, { currency_code: "USD", value: "25.70" });
});

// removeLine

test("removeLine reads the invoice, then PUTs an editable body without the dropped item", async () => {
  const { gateway, seen } = fakePayPal();
  await gateway().removeLine(ID, "ITEM-A", "lr-edit-1");
  const calls = seen.filter((s) => s.path !== "/v1/oauth2/token");
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
  const put = calls[1];
  assert.equal(put.path.split("?")[0], `/v2/invoicing/invoices/${ID}`);
  const query = new URLSearchParams(put.path.split("?")[1]);
  assert.equal(query.get("send_to_recipient"), "false");
  assert.equal(put.headers["paypal-request-id"], "lr-edit-1");
  for (const key of ["amount", "due_amount", "links", "status", "payments", "refunds"]) assert.ok(!(key in put.body), key);
  assert.equal(put.body.items.length, 1);
  assert.equal(put.body.items[0].name, "Gundruk achar (jar, 250 g)");
  assert.ok(!("id" in put.body.items[0]));
  assert.equal(put.body.detail.reference, "lot-recall-demo");
});

test("removeLine keeps only name and percent of the tax on the kept items", async () => {
  const body = rawInvoice(ID, {
    items: [
      { id: "ITEM-A", name: "Gone", description: "d", quantity: "1", unit_amount: money("1.00") },
      { id: "ITEM-B", name: "Kept", description: "d", quantity: "1", unit_amount: money("2.00"), tax: { name: "VAT", percent: "13", amount: money("0.26") } },
    ],
  });
  const { gateway, seen } = fakePayPal({ [`GET /v2/invoicing/invoices/${ID}`]: () => Response.json(body) });
  await gateway().removeLine(ID, "ITEM-A", "r");
  const put = seen.find((s) => s.method === "PUT")!;
  assert.deepEqual(put.body.items, [{ name: "Kept", description: "d", quantity: "1", unit_amount: money("2.00"), tax: { name: "VAT", percent: "13" } }]);
});

test("removeLine sends no PUT when the item is already gone", async () => {
  const { gateway, seen } = fakePayPal();
  await gateway().removeLine(ID, "ITEM-GONE", "lr-edit-2");
  assert.equal(seen.filter((s) => s.method === "PUT").length, 0);
  assert.equal(seen.filter((s) => s.method === "GET").length, 1);
});

// listDemo

test("listDemo searches by reference and reads only invoices with a seed key", async () => {
  const seedNote = `Order 01. Demo data (${SEED_TAG}${SEED_SET}01).`;
  const search = {
    items: [
      { id: "INV-SEED", detail: { reference: "lot-recall-demo", note: seedNote } },
      { id: "INV-PROBE", detail: { reference: "lot-recall-demo", note: "probe B" } },
    ],
  };
  const { gateway, seen } = fakePayPal({
    "POST /v2/invoicing/search-invoices": () => Response.json(search),
    "GET /v2/invoicing/invoices/INV-SEED": () => Response.json(rawInvoice("INV-SEED", { detail: { ...rawInvoice().detail, note: seedNote } })),
  });
  const out = await gateway().listDemo();
  const searchCall = seen.find((s) => s.method === "POST" && s.path.startsWith("/v2/invoicing/search-invoices"))!;
  assert.deepEqual(searchCall.body, { reference: "lot-recall-demo" });
  assert.deepEqual(seen.filter((s) => s.method === "GET").map((s) => s.path), ["/v2/invoicing/invoices/INV-SEED"]);
  assert.deepEqual(out.map((i) => i.id), ["INV-SEED"]);
});

test("listDemo drops an invoice whose full body no longer carries the seed key", async () => {
  const { gateway } = fakePayPal({
    "POST /v2/invoicing/search-invoices": () => Response.json({ items: [{ id: ID, detail: { reference: "lot-recall-demo", note: `${SEED_TAG}${SEED_SET}01` } }] }),
    [`GET /v2/invoicing/invoices/${ID}`]: () => Response.json(rawInvoice(ID, { detail: { reference: "lot-recall-demo", note: "edited" } })),
  });
  assert.deepEqual(await gateway().listDemo(), []);
});

test("isDemo needs the reference and a seed key in the note", () => {
  const key = `${SEED_TAG}${SEED_SET}07`;
  assert.equal(isDemo({ reference: "lot-recall-demo", note: `x (${key}).` }), true);
  assert.equal(isDemo({ reference: "lot-recall-demo", note: "probe B" }), false);
  assert.equal(isDemo({ reference: "other", note: key }), false);
});

// parsing

test("parseInvoice maps lines, tax, paid and refunded amounts", () => {
  const inv = parseInvoice(rawInvoice());
  assert.equal(inv.id, ID);
  assert.equal(inv.number, "0001");
  assert.equal(inv.status, "PAID");
  assert.equal(inv.invoiceDate, "2026-03-05");
  assert.equal(inv.buyer, "Asha Gurung");
  assert.equal(inv.email, "asha@example.com");
  assert.equal(inv.totalCents, 2570);
  assert.equal(inv.paidCents, 2570);
  assert.equal(inv.refundedCents, 500);
  assert.equal(inv.payerUrl, "https://www.sandbox.paypal.com/invoice/p/#X");
  assert.equal(inv.lines.length, 2);
  assert.deepEqual(inv.lines[0], { index: 0, itemId: "ITEM-A", name: "Timur achar (jar, 250 g)", description: "Sichuan pepper pickle", quantity: "2", unitCents: 850, taxName: "VAT", taxPercent: "10.0", taxCents: 170 });
  assert.equal(inv.lines[1].taxCents, 0);
  assert.equal(inv.lines[1].taxName, null);
});

test("parseInvoice builds the buyer from given name and surname and defaults the rest", () => {
  const inv = parseInvoice({ id: "X", primary_recipients: [{ billing_info: { name: { given_name: "Bikash", surname: "Rai" } } }] });
  assert.equal(inv.buyer, "Bikash Rai");
  assert.equal(inv.status, "UNKNOWN");
  assert.equal(inv.paidCents, 0);
  assert.equal(inv.refundedCents, 0);
  assert.equal(inv.payerUrl, null);
  assert.deepEqual(inv.lines, []);
});

test("toCents reads decimal strings into integer cents", () => {
  assert.equal(toCents("18.70"), 1870);
  assert.equal(toCents("5"), 500);
  assert.equal(toCents("0.5"), 50);
  assert.equal(toCents("-2.25"), -225);
  assert.equal(toCents("abc"), 0);
  assert.equal(toCents(undefined), 0);
});

// errors

test("a non-2xx answer throws PayPalError with the issue from details", async () => {
  const { gateway } = fakePayPal({
    [`POST /v2/invoicing/invoices/${ID}/refunds`]: () => Response.json({ name: "UNPROCESSABLE_ENTITY", debug_id: "dbg-1", details: [{ issue: "REFUND_AMOUNT_EXCEEDED" }] }, { status: 422 }),
  });
  await assert.rejects(
    () => gateway().refund(ID, 100, "2026-11-12", "r"),
    (err: unknown) => err instanceof PayPalError && err.status === 422 && err.issue === "REFUND_AMOUNT_EXCEEDED" && err.debugId === "dbg-1" && /422 REFUND_AMOUNT_EXCEEDED/.test(err.message),
  );
});

test("a non-JSON error body still throws PayPalError with UNKNOWN", async () => {
  const { gateway } = fakePayPal({ [`GET /v2/invoicing/invoices/${ID}`]: () => new Response("<html>bad gateway</html>", { status: 502 }) });
  await assert.rejects(
    () => gateway().get(ID),
    (err: unknown) => err instanceof PayPalError && err.status === 502 && err.issue === "UNKNOWN" && err.debugId === "n/a",
  );
});

test("the trace callback sees every call", async () => {
  const { gateway } = fakePayPal();
  const calls: Call[] = [];
  await gateway().get(ID, (c) => calls.push(c));
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.status]), [
    ["POST", "/v1/oauth2/token", 200],
    ["GET", `/v2/invoicing/invoices/${ID}`, 200],
  ]);
});

// mock gateway

const seeded = () => mockGateway(SEED.map((s) => s.invoice), SEED.map((s) => s.state));

test("mockGateway builds the seed set with the seeded states", async () => {
  const gw = seeded();
  assert.equal(gw.mode, "mock");
  const all = await gw.listDemo();
  assert.equal(all.length, SEED.length);
  const count = (status: string) => all.filter((i) => i.status === status).length;
  assert.equal(count("MARKED_AS_PAID"), SEED.filter((s) => s.state === "PAID").length);
  assert.equal(count("UNPAID"), SEED.filter((s) => s.state === "SENT").length);
  assert.equal(count("DRAFT"), SEED.filter((s) => s.state === "DRAFT").length);
  const first = all[0];
  assert.equal(first.paidCents, first.totalCents);
  assert.equal(first.lines[0].taxCents, 170);
});

test("mockGateway refund with the same request id twice refunds once", async () => {
  const gw = seeded();
  const paid = (await gw.listDemo()).find((i) => i.status === "MARKED_AS_PAID")!;
  const a = await gw.refund(paid.id, 1870, "2026-11-12", "same-id");
  const b = await gw.refund(paid.id, 1870, "2026-11-12", "same-id");
  assert.equal(a, b);
  const after = await gw.get(paid.id);
  assert.equal(after.refundedCents, 1870);
  assert.equal(after.status, "PARTIALLY_REFUNDED");
});

test("mockGateway refuses a refund above the paid amount", async () => {
  const gw = seeded();
  const paid = (await gw.listDemo()).find((i) => i.status === "MARKED_AS_PAID")!;
  await assert.rejects(
    () => gw.refund(paid.id, paid.paidCents + 1, "2026-11-12", "too-much"),
    (err: unknown) => err instanceof PayPalError && err.issue === "REFUND_AMOUNT_EXCEEDED",
  );
});

test("mockGateway marks the invoice REFUNDED when the whole paid amount goes back", async () => {
  const gw = seeded();
  const paid = (await gw.listDemo()).find((i) => i.status === "MARKED_AS_PAID")!;
  await gw.refund(paid.id, paid.paidCents, "2026-11-12", "all");
  assert.equal((await gw.get(paid.id)).status, "REFUNDED");
});

test("mockGateway removeLine drops the line, renumbers and moves UNPAID to SENT", async () => {
  const gw = seeded();
  const unpaid = (await gw.listDemo()).find((i) => i.status === "UNPAID")!;
  const before = unpaid.lines.length;
  await gw.removeLine(unpaid.id, unpaid.lines[0].itemId, "r");
  const after = await gw.get(unpaid.id);
  assert.equal(after.lines.length, before - 1);
  assert.deepEqual(after.lines.map((l) => l.index), after.lines.map((_, i) => i));
  assert.equal(after.status, "SENT");
  assert.ok(after.totalCents < unpaid.totalCents);
});

test("mockGateway recordPayment for the total marks the invoice paid", async () => {
  const gw = seeded();
  const unpaid = (await gw.listDemo()).find((i) => i.status === "UNPAID")!;
  await gw.recordPayment(unpaid.id, unpaid.totalCents, "2026-11-12");
  const after = await gw.get(unpaid.id);
  assert.equal(after.status, "MARKED_AS_PAID");
  assert.equal(after.paidCents, unpaid.totalCents);
});

test("mockGateway get returns a copy, so a caller cannot change the stored invoice", async () => {
  const gw = seeded();
  const [one] = await gw.listDemo();
  one.paidCents = 1;
  assert.notEqual((await gw.get(one.id)).paidCents, 1);
});

test("mockGateway throws a 404 PayPalError for an unknown id", async () => {
  await assert.rejects(
    () => seeded().get("NOPE"),
    (err: unknown) => err instanceof PayPalError && err.status === 404,
  );
});
