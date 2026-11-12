// The rule engine: pure functions that decide every action. The model output is untrusted input.
import { createHash } from "node:crypto";
import type { Invoice, Line } from "./gateway.js";

export const MAX_ACTIONS = 200;
export const MAX_REFUND_CENTS = 5_000_000;
export const MAX_RANGE_DAYS = 366;

export type Kind = "refund_line" | "pull_line" | "edit_draft_line" | "refused" | "skipped";
export type ModelPlan = {
  product_phrase: string;
  from_date: string;
  to_date: string;
  hazard: string;
  matches: unknown[];
  notice_template: string;
};
export type Action = {
  key: string;
  invoiceId: string;
  number: string;
  buyer: string;
  email: string;
  date: string;
  status: string;
  lineIndex: number;
  itemId: string;
  item: string;
  quote: string;
  verdict: string;
  kind: Kind;
  amountCents: number;
  reason: string;
  notice: string | null;
  payerUrl: string | null;
  source: "model" | "name sweep";
};
export type Decision = {
  ok: boolean;
  error: string | null;
  actions: Action[];
  refundCents: number;
  hash: string;
  window: { from: string; to: string } | null;
  templateRejected: boolean;
};

export const formatUsd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Trim and collapse whitespace. Case stays as written.
export const squash = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

export function quoteMatches(quote: string, line: Pick<Line, "name" | "description">): boolean {
  const q = squash(quote);
  return q.length > 0 && (q === squash(line.name) || q === squash(line.description));
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dayNumber = (iso: string) => {
  if (!ISO.test(iso)) return NaN;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso ? NaN : t / 86_400_000;
};

export function checkWindow(from: string, to: string): string | null {
  const a = dayNumber(from);
  const b = dayNumber(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return "The recall dates are not valid dates. Write them as in 'between March 1 and March 20'.";
  if (a > b) return "The recall start date is after the end date. Check the dates in the sentence.";
  if (b - a + 1 > MAX_RANGE_DAYS) return `The recall covers more than ${MAX_RANGE_DAYS} days. Name a shorter batch window.`;
  return null;
}

// ISO dates compare as strings. Both edges are inside the window.
export const inWindow = (date: string, from: string, to: string) => ISO.test(date) && date >= from && date <= to;

// Quantity times unit price plus the line tax, in integer cents from PayPal data.
export function lineCents(line: Pick<Line, "quantity" | "unitCents" | "taxCents">): number {
  const m = /^(\d+)(?:\.(\d{1,5}))?$/.exec(line.quantity.trim());
  if (!m) return NaN;
  const scale = 10 ** (m[2]?.length ?? 0);
  const qtyScaled = Number(m[1]) * scale + Number(m[2] ?? 0);
  return Math.round((qtyScaled * line.unitCents) / scale) + line.taxCents;
}

const CURRENCY_DIGITS = /[$€£¥₹]\s?\d|\d\s?[$€£¥₹]|\b(?:USD|NPR|Rs\.?)\s?\d|\d\s?(?:USD|NPR|Rs)\b/i;
export const hasMoney = (text: string) => CURRENCY_DIGITS.test(text);

export const DEFAULT_TEMPLATE =
  "Dear {buyer}, we are recalling {item} from your order {order} because of a safety problem with one batch. Please do not eat it. {refund}";

// The model writes the template. The server fills every value and rejects any amount the model wrote.
export function fillNotice(template: string, values: { buyer: string; order: string; item: string; refund: string }): string {
  return template.replace(/\{(buyer|order|item|refund)\}/g, (_m, k: keyof typeof values) => values[k]);
}

export function refundPhrase(kind: Kind, cents: number): string {
  if (kind === "refund_line") return `We recorded a refund of ${formatUsd(cents)} for this item.`;
  if (kind === "pull_line") return "We removed this item from your unpaid invoice, so you do not pay for it.";
  return "We removed this item from your order before we sent the invoice.";
}

export const actionKey = (recallId: string, invoiceId: string, itemId: string) => `${recallId}:${invoiceId}:${itemId}`;

export type DecideInput = {
  recallId: string;
  plan: ModelPlan;
  invoices: Invoice[];
  // Line item ids that a refund already covered, in any recall.
  refundedItems?: Set<string>;
};

export function decide({ recallId, plan, invoices, refundedItems = new Set() }: DecideInput): Decision {
  const fail = (error: string): Decision => ({ ok: false, error, actions: [], refundCents: 0, hash: "", window: null, templateRejected: false });
  const windowError = checkWindow(plan.from_date, plan.to_date);
  if (windowError) return fail(windowError);
  const from = plan.from_date;
  const to = plan.to_date;

  const templateRejected = !plan.notice_template || hasMoney(plan.notice_template) || hasMoney(plan.hazard ?? "");
  const template = templateRejected ? DEFAULT_TEMPLATE : plan.notice_template;

  const byId = new Map(invoices.map((inv) => [inv.id, inv]));
  // Refundable money left per invoice, reduced as refund actions are planned.
  const left = new Map(invoices.map((inv) => [inv.id, Math.max(0, inv.paidCents - inv.refundedCents)]));
  const seen = new Set<string>();
  const actions: Action[] = [];

  // Name sweep: a line with the exact name of a verified recalled line joins the plan even when
  // the model left it out. The same rules then decide it, so the model cannot drop a buyer.
  const modelMatches = (Array.isArray(plan.matches) ? plan.matches : []).map((raw) => (raw ?? {}) as Record<string, unknown>);
  const listed = new Set(modelMatches.map((m) => `${m.invoice_id}#${m.line_index}`));
  const names = new Set<string>();
  for (const m of modelMatches) {
    const line = byId.get(String(m.invoice_id ?? ""))?.lines[Number(m.line_index)];
    if (line && m.verdict === "recalled" && quoteMatches(String(m.quote ?? ""), line)) names.add(squash(line.name));
  }
  const swept = invoices.flatMap((inv) =>
    inv.lines
      .filter((l) => names.has(squash(l.name)) && !listed.has(`${inv.id}#${l.index}`))
      .map((l) => ({ invoice_id: inv.id, line_index: l.index, quote: l.name, verdict: "recalled", reason: "", swept: true }) as Record<string, unknown>),
  );

  for (const m of [...modelMatches, ...swept]) {
    const invoiceId = String(m.invoice_id ?? "");
    const lineIndex = Number(m.line_index);
    const inv = byId.get(invoiceId);
    const line = inv && Number.isInteger(lineIndex) ? inv.lines[lineIndex] : undefined;
    if (!inv || !line) continue;
    const key = actionKey(recallId, inv.id, line.itemId);
    if (seen.has(key)) continue;
    seen.add(key);

    const quote = String(m.quote ?? "");
    const verdict = String(m.verdict ?? "");
    const modelReason = String(m.reason ?? "").slice(0, 300);
    const base = {
      key,
      invoiceId: inv.id,
      number: inv.number,
      buyer: inv.buyer,
      email: inv.email,
      date: inv.invoiceDate,
      status: inv.status,
      lineIndex,
      itemId: line.itemId,
      item: line.name,
      quote,
      verdict,
      source: m.swept ? ("name sweep" as const) : ("model" as const),
      amountCents: 0,
      notice: null,
      payerUrl: inv.payerUrl,
    };
    const refuse = (reason: string, kind: Kind = "refused") => actions.push({ ...base, kind, reason });

    if (!quoteMatches(quote, line)) {
      refuse("quote does not match the invoice line");
      continue;
    }
    if (!inWindow(inv.invoiceDate, from, to)) {
      refuse("outside the recall dates");
      continue;
    }
    if (verdict !== "recalled") {
      refuse(verdict === "lookalike" ? `lookalike: ${hasMoney(modelReason) ? "the model named a similar product" : modelReason}` : "the model gave no verdict");
      continue;
    }
    const cents = lineCents(line);
    if (!Number.isFinite(cents) || cents <= 0) {
      refuse("the line amount is not readable");
      continue;
    }
    const st = inv.status;
    if (st === "CANCELLED") {
      refuse("the invoice is cancelled", "skipped");
      continue;
    }
    // MARKED_AS_REFUNDED is the full refund of an external payment.
    if (st === "REFUNDED" || st === "MARKED_AS_REFUNDED") {
      refuse("already refunded", "skipped");
      continue;
    }
    const paidLike = st === "PAID" || st === "MARKED_AS_PAID" || st === "PARTIALLY_REFUNDED";
    if (paidLike) {
      const room = left.get(inv.id) ?? 0;
      if (refundedItems.has(line.itemId) || room <= 0) {
        refuse("already refunded", "skipped");
        continue;
      }
      const amount = Math.min(cents, room);
      left.set(inv.id, room - amount);
      actions.push({ ...base, kind: "refund_line", amountCents: amount, reason: amount < cents ? `refund capped at the ${formatUsd(room)} still paid` : "paid invoice: refund this line only" });
      continue;
    }
    if (st === "UNPAID" || st === "SENT" || st === "DRAFT") {
      if (inv.lines.length < 2) {
        refuse("this is the only line on the invoice; cancel the invoice in PayPal");
        continue;
      }
      const kind: Kind = st === "DRAFT" ? "edit_draft_line" : "pull_line";
      actions.push({ ...base, kind, amountCents: cents, reason: st === "DRAFT" ? "draft: remove the line before it is sent" : "unpaid invoice: remove the line" });
      continue;
    }
    refuse(`invoice status ${st} is not handled; check it in PayPal`, "skipped");
  }

  const work = actions.filter((a) => a.kind !== "refused" && a.kind !== "skipped");
  const refundCents = work.filter((a) => a.kind === "refund_line").reduce((s, a) => s + a.amountCents, 0);
  if (work.length > MAX_ACTIONS) return fail(`The recall needs ${work.length} actions. The limit is ${MAX_ACTIONS}. Split the recall by date.`);
  if (refundCents > MAX_REFUND_CENTS) return fail(`The refunds total ${formatUsd(refundCents)}. The limit is ${formatUsd(MAX_REFUND_CENTS)} for one recall. Split the recall by date.`);

  for (const a of work) {
    a.notice = fillNotice(template, { buyer: a.buyer || a.email, order: a.number, item: a.item, refund: refundPhrase(a.kind, a.amountCents) });
  }
  actions.sort((a, b) => order(a.kind) - order(b.kind) || a.date.localeCompare(b.date));
  return { ok: true, error: null, actions, refundCents, hash: planHash(actions, invoices), window: { from, to }, templateRejected };
}

const order = (k: Kind) => ["refund_line", "pull_line", "edit_draft_line", "refused", "skipped"].indexOf(k);

// The hash covers every action and the PayPal state it read. A change in PayPal changes the hash.
export function planHash(actions: Action[], invoices: Invoice[]): string {
  const touched = new Set(actions.map((a) => a.invoiceId));
  const state = invoices
    .filter((inv) => touched.has(inv.id))
    .map((inv) => [inv.id, inv.status, inv.paidCents, inv.refundedCents, inv.lines.map((l) => l.itemId)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const acts = actions.map((a) => [a.key, a.kind, a.amountCents]);
  return createHash("sha256").update(JSON.stringify([acts, state])).digest("hex").slice(0, 16);
}

export type ExecuteCheck = { ok: true } | { ok: false; status: number; error: string };

// EXECUTE needs the previewed hash and an explicit confirm flag.
export function checkExecute(previewHash: string, sentHash: unknown, confirm: unknown): ExecuteCheck {
  if (confirm !== true) return { ok: false, status: 400, error: "Tick 'I reviewed the dry run' to confirm, then run the recall." };
  if (typeof sentHash !== "string" || sentHash !== previewHash) return { ok: false, status: 409, error: "This is not the dry run on screen. Preview the recall again, then confirm." };
  return { ok: true };
}
