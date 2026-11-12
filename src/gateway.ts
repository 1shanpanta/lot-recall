import { randomUUID } from "node:crypto";

export type Line = {
  index: number;
  itemId: string;
  name: string;
  description: string;
  quantity: string;
  unitCents: number;
  taxName: string | null;
  taxPercent: string | null;
  taxCents: number;
};
export type Invoice = {
  id: string;
  number: string;
  status: string;
  invoiceDate: string;
  buyer: string;
  email: string;
  note: string;
  reference: string;
  totalCents: number;
  paidCents: number;
  refundedCents: number;
  payerUrl: string | null;
  lines: Line[];
};
export type NewLine = { name: string; description: string; quantity: number; unitCents: number; taxPercent?: string };
export type NewInvoice = { invoiceDate: string; buyer: string; email: string; note: string; lines: NewLine[] };
export type Call = { method: string; path: string; status: number; ms: number };
export type Trace = (call: Call) => void;

export const DEMO_REFERENCE = "lot-recall-demo";
// Seeded invoices carry this key in the note. Invoices with the reference but no key are left alone.
export const SEED_TAG = "seed:lr-";
// LOT_RECALL_SET picks a fresh demo set (lowercase letters), for example "b" gives keys seed:lr-b01 to seed:lr-b18.
export const SEED_SET = (process.env.LOT_RECALL_SET ?? "").toLowerCase().replace(/[^a-z]/g, "");
const SET_KEY = new RegExp(`${SEED_TAG}${SEED_SET}\\d{2}\\b`);

export interface Gateway {
  readonly mode: "sandbox" | "mock";
  listDemo(trace?: Trace): Promise<Invoice[]>;
  get(id: string, trace?: Trace): Promise<Invoice>;
  create(inv: NewInvoice, trace?: Trace): Promise<string>;
  send(id: string, trace?: Trace): Promise<void>;
  recordPayment(id: string, cents: number, date: string, trace?: Trace): Promise<void>;
  refund(id: string, cents: number, date: string, requestId: string, trace?: Trace): Promise<string>;
  removeLine(id: string, itemId: string, requestId: string, trace?: Trace): Promise<void>;
}

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly issue: string,
    readonly debugId: string,
  ) {
    super(`PayPal ${status} ${issue} debug_id ${debugId}`);
  }
}

const SANDBOX = "https://api-m.sandbox.paypal.com";
type Json = Record<string, any>;

export const toCents = (value: unknown) => {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? "0").trim());
  if (!m) return 0;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return m[1] ? -cents : cents;
};
export const usd = (cents: number) => ({ currency_code: "USD", value: (cents / 100).toFixed(2) });

// Maps one invoice from GET /v2/invoicing/invoices/{id} to the shape the rules read.
export function parseInvoice(j: Json): Invoice {
  const billing = j.primary_recipients?.[0]?.billing_info ?? {};
  const items: Json[] = Array.isArray(j.items) ? j.items : [];
  return {
    id: String(j.id),
    number: String(j.detail?.invoice_number ?? ""),
    status: String(j.status ?? "UNKNOWN"),
    invoiceDate: String(j.detail?.invoice_date ?? ""),
    buyer: String(billing.name?.full_name ?? [billing.name?.given_name, billing.name?.surname].filter(Boolean).join(" ") ?? ""),
    email: String(billing.email_address ?? ""),
    note: String(j.detail?.note ?? ""),
    reference: String(j.detail?.reference ?? ""),
    totalCents: toCents(j.amount?.value),
    paidCents: toCents(j.payments?.paid_amount?.value),
    refundedCents: toCents(j.refunds?.refund_amount?.value),
    payerUrl: typeof j.detail?.metadata?.recipient_view_url === "string" ? j.detail.metadata.recipient_view_url : null,
    lines: items.map((it, index) => ({
      index,
      itemId: String(it.id ?? `line-${index}`),
      name: String(it.name ?? ""),
      description: String(it.description ?? ""),
      quantity: String(it.quantity ?? "1"),
      unitCents: toCents(it.unit_amount?.value),
      taxName: it.tax ? String(it.tax.name ?? "Tax") : null,
      taxPercent: it.tax ? String(it.tax.percent ?? "0") : null,
      taxCents: toCents(it.tax?.amount?.value),
    })),
  };
}

// PUT needs the invoice without the fields PayPal computes. Probe: sending the GET body back
// gives 400 calculation_error on amount.breakdown, so amount, item ids and tax amounts go.
export function editableBody(j: Json, dropItemId: string): Json {
  const { amount: _a, due_amount: _d, links: _l, status: _s, payments: _p, refunds: _r, ...rest } = j;
  rest.items = (j.items as Json[])
    .filter((it) => it.id !== dropItemId)
    .map(({ id: _id, tax, ...it }) => (tax ? { ...it, tax: { name: tax.name, percent: tax.percent } } : it));
  return rest;
}

export const isDemo = (inv: { reference: string; note: string }) => inv.reference === DEMO_REFERENCE && SET_KEY.test(inv.note);

// Sandbox only. Invoicing v2 over fetch. No Payouts and no transfer API.
export function paypalSandboxGateway(clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch, base = SANDBOX): Gateway {
  let token: { value: string; expiresAt: number } | null = null;

  async function request(method: string, path: string, init: RequestInit, trace?: Trace): Promise<Json> {
    const started = Date.now();
    const res = await fetchImpl(base + path, { ...init, method, signal: AbortSignal.timeout(20_000) });
    trace?.({ method, path, status: res.status, ms: Date.now() - started });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = {};
    }
    if (!res.ok) throw new PayPalError(res.status, json.details?.[0]?.issue ?? json.name ?? json.error ?? "UNKNOWN", json.debug_id ?? "n/a");
    return json;
  }

  async function bearer(trace?: Trace): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const json = await request(
      "POST",
      "/v1/oauth2/token",
      {
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      },
      trace,
    );
    token = { value: String(json.access_token), expiresAt: Date.now() + Number(json.expires_in ?? 0) * 1000 };
    return token.value;
  }

  async function api(method: string, path: string, trace?: Trace, body?: unknown, requestId?: string): Promise<Json> {
    const headers: Record<string, string> = { authorization: `Bearer ${await bearer(trace)}`, "content-type": "application/json" };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    return request(method, path, { headers, body: body === undefined ? undefined : JSON.stringify(body) }, trace);
  }
  const at = (id: string) => `/v2/invoicing/invoices/${encodeURIComponent(id)}`;
  const raw = (id: string, trace?: Trace) => api("GET", at(id), trace);

  return {
    mode: "sandbox",
    // POST /v2/invoicing/search-invoices {reference} lists summaries without items, so each id gets a GET.
    async listDemo(trace) {
      const found = await api("POST", "/v2/invoicing/search-invoices?page=1&page_size=100&total_required=true", trace, { reference: DEMO_REFERENCE });
      const ids = ((found.items ?? []) as Json[])
        .filter((it) => isDemo({ reference: String(it.detail?.reference ?? ""), note: String(it.detail?.note ?? "") }))
        .map((it) => String(it.id));
      const out = await Promise.all(ids.map(async (id) => parseInvoice(await raw(id, trace))));
      return out.filter(isDemo);
    },
    async get(id, trace) {
      return parseInvoice(await raw(id, trace));
    },
    // POST /v2/invoicing/invoices {detail:{reference, invoice_date, note, payment_term}, primary_recipients, items[]} -> 201 {id}
    async create(inv, trace) {
      const created = await api(
        "POST",
        "/v2/invoicing/invoices",
        trace,
        {
          detail: {
            currency_code: "USD",
            reference: DEMO_REFERENCE,
            note: inv.note,
            invoice_date: inv.invoiceDate,
            payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: "2026-12-31" },
          },
          invoicer: { business_name: "Himal Pickles" },
          primary_recipients: [{ billing_info: { name: { given_name: inv.buyer.split(" ")[0], surname: inv.buyer.split(" ").slice(1).join(" ") }, email_address: inv.email } }],
          items: inv.lines.map((l) => ({
            name: l.name,
            description: l.description,
            quantity: String(l.quantity),
            unit_amount: usd(l.unitCents),
            unit_of_measure: "QUANTITY",
            ...(l.taxPercent ? { tax: { name: "VAT", percent: l.taxPercent } } : {}),
          })),
        },
        randomUUID(),
      );
      const id = typeof created.id === "string" ? created.id : String(created.href ?? "").split("/").pop();
      if (!id) throw new Error("PayPal returned no invoice id");
      return id;
    },
    // POST .../send {send_to_recipient:false}: status becomes UNPAID, no email leaves PayPal.
    async send(id, trace) {
      await api("POST", `${at(id)}/send`, trace, { send_to_recipient: false, send_to_invoicer: false }, `send-${id}`);
    },
    // POST .../payments {method, payment_date, amount}: an EXTERNAL payment, status MARKED_AS_PAID. No money moves.
    // Probe: BANK_TRANSFER, PAYPAL, CASH, CHECK, CREDIT_CARD, DEBIT_CARD, WIRE_TRANSFER and OTHER are all accepted.
    async recordPayment(id, cents, date, trace) {
      await api("POST", `${at(id)}/payments`, trace, { method: "BANK_TRANSFER", payment_date: date, amount: usd(cents), note: "Recorded for the Lot Recall demo." }, `pay-${id}`);
    },
    // POST .../refunds {method, refund_date, amount} -> {refund_id}. Status becomes PARTIALLY_REFUNDED or REFUNDED.
    async refund(id, cents, date, requestId, trace) {
      const out = await api("POST", `${at(id)}/refunds`, trace, { method: "BANK_TRANSFER", refund_date: date, amount: usd(cents) }, requestId);
      return String(out.refund_id ?? "");
    },
    // PUT /v2/invoicing/invoices/{id} works on DRAFT and on sent UNPAID invoices (probe: 200, status SENT after).
    async removeLine(id, itemId, requestId, trace) {
      const current = await raw(id, trace);
      if (!(current.items as Json[] | undefined)?.some((it) => it.id === itemId)) return;
      await api("PUT", `${at(id)}?send_to_recipient=false&send_to_invoicer=false`, trace, editableBody(current, itemId), requestId);
    },
  };
}

// Stands in for PayPal when no sandbox keys exist. Same states and the same seed data.
export function mockGateway(seed: NewInvoice[] = [], states: string[] = []): Gateway {
  const invoices = new Map<string, Invoice>();
  const refundIds = new Map<string, string>();
  let n = 0;
  const find = (id: string) => {
    const inv = invoices.get(id);
    if (!inv) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "mock");
    return inv;
  };
  const total = (inv: Invoice) => inv.lines.reduce((s, l) => s + Math.round(Number(l.quantity) * l.unitCents) + l.taxCents, 0);
  const gw: Gateway = {
    mode: "mock",
    async listDemo() {
      return [...invoices.values()].filter(isDemo).map((i) => structuredClone(i));
    },
    async get(id) {
      return structuredClone(find(id));
    },
    async create(inv) {
      n++;
      const id = `MOCK-${String(n).padStart(4, "0")}`;
      const lines: Line[] = inv.lines.map((l, index) => {
        const base = l.quantity * l.unitCents;
        return {
          index,
          itemId: `ITEM-${n}-${index}`,
          name: l.name,
          description: l.description,
          quantity: String(l.quantity),
          unitCents: l.unitCents,
          taxName: l.taxPercent ? "VAT" : null,
          taxPercent: l.taxPercent ?? null,
          taxCents: l.taxPercent ? Math.round((base * Number(l.taxPercent)) / 100) : 0,
        };
      });
      const created: Invoice = { id, number: `M${String(n).padStart(4, "0")}`, status: "DRAFT", invoiceDate: inv.invoiceDate, buyer: inv.buyer, email: inv.email, note: inv.note, reference: DEMO_REFERENCE, totalCents: 0, paidCents: 0, refundedCents: 0, payerUrl: null, lines };
      created.totalCents = total(created);
      invoices.set(id, created);
      return id;
    },
    async send(id) {
      find(id).status = "UNPAID";
    },
    async recordPayment(id, cents) {
      const inv = find(id);
      inv.paidCents += cents;
      inv.status = inv.paidCents >= inv.totalCents ? "MARKED_AS_PAID" : "PARTIALLY_PAID";
    },
    async refund(id, cents, _date, requestId) {
      const known = refundIds.get(requestId);
      if (known) return known;
      const inv = find(id);
      if (inv.refundedCents + cents > inv.paidCents) throw new PayPalError(422, "REFUND_AMOUNT_EXCEEDED", "mock");
      inv.refundedCents += cents;
      inv.status = inv.refundedCents >= inv.paidCents ? "REFUNDED" : "PARTIALLY_REFUNDED";
      const rid = `MOCKREF-${refundIds.size + 1}`;
      refundIds.set(requestId, rid);
      return rid;
    },
    async removeLine(id, itemId) {
      const inv = find(id);
      inv.lines = inv.lines.filter((l) => l.itemId !== itemId).map((l, index) => ({ ...l, index }));
      inv.totalCents = total(inv);
      if (inv.status === "UNPAID") inv.status = "SENT";
    },
  };
  // create() has no await inside, so its body runs at once and n names the new invoice.
  seed.forEach((inv, i) => {
    void gw.create(inv);
    const state = states[i] ?? "DRAFT";
    const made = find(`MOCK-${String(n).padStart(4, "0")}`);
    if (state !== "DRAFT") made.status = "UNPAID";
    if (state === "PAID") {
      made.paidCents = made.totalCents;
      made.status = "MARKED_AS_PAID";
    }
  });
  return gw;
}
