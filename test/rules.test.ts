import assert from "node:assert/strict";
import { test } from "node:test";
import type { Invoice, Line } from "../src/gateway.js";
import {
  DEFAULT_TEMPLATE,
  MAX_ACTIONS,
  MAX_REFUND_CENTS,
  checkExecute,
  checkWindow,
  decide,
  fillNotice,
  hasMoney,
  lineCents,
  planHash,
  quoteMatches,
  type ModelPlan,
} from "../src/rules.js";

const NAME = "Timur achar (jar, 250 g)";

function line(over: Partial<Line> = {}): Line {
  return { index: 0, itemId: "I0", name: NAME, description: "Sichuan pepper pickle", quantity: "2", unitCents: 850, taxName: "VAT", taxPercent: "10", taxCents: 170, ...over };
}

// Two lines by default: the recalled line (1870 cents with tax) and a plain second line.
function invoice(over: Partial<Invoice> = {}, lines?: Line[]): Invoice {
  return {
    id: "INV-1",
    number: "0001",
    status: "MARKED_AS_PAID",
    invoiceDate: "2026-03-05",
    buyer: "Asha Gurung",
    email: "asha@example.com",
    note: "seed:lr-01",
    reference: "lot-recall-demo",
    totalCents: 2570,
    paidCents: 2570,
    refundedCents: 0,
    payerUrl: null,
    lines: lines ?? [line({ index: 0, itemId: "I0" }), line({ index: 1, itemId: "I1", name: "Gundruk achar (jar, 250 g)", description: "Fermented greens", quantity: "1", unitCents: 700, taxName: null, taxPercent: null, taxCents: 0 })],
    ...over,
  };
}

const match = (invoiceId: string, lineIndex: number, over: Record<string, unknown> = {}) => ({
  invoice_id: invoiceId,
  line_index: lineIndex,
  quote: NAME,
  verdict: "recalled",
  reason: "same product",
  ...over,
});

const plan = (matches: unknown[], over: Partial<ModelPlan> = {}): ModelPlan => ({
  product_phrase: "timur achar",
  from_date: "2026-03-01",
  to_date: "2026-03-20",
  hazard: "may contain peanuts",
  matches,
  notice_template: "Dear {buyer}, {item} on order {order} is recalled. {refund}",
  ...over,
});

const run = (matches: unknown[], invoices: Invoice[], over: Partial<ModelPlan> = {}, refundedItems?: Set<string>) =>
  decide({ recallId: "R-1", plan: plan(matches, over), invoices, refundedItems });

// quote matching

test("a quote that differs from the invoice line is refused", () => {
  const d = run([match("INV-1", 0, { quote: "Timur achar jar" })], [invoice()]);
  assert.equal(d.ok, true);
  assert.equal(d.actions.length, 1);
  assert.equal(d.actions[0].kind, "refused");
  assert.equal(d.actions[0].reason, "quote does not match the invoice line");
});

test("extra spaces and newlines in the quote are accepted", () => {
  assert.equal(quoteMatches("  Timur   achar\n(jar,  250 g) ", line()), true);
  const d = run([match("INV-1", 0, { quote: "Timur  achar\n(jar, 250 g)" })], [invoice()]);
  assert.equal(d.actions[0].kind, "refund_line");
});

test("a case change in the quote is refused", () => {
  assert.equal(quoteMatches(NAME.toLowerCase(), line()), false);
  const d = run([match("INV-1", 0, { quote: NAME.toUpperCase() })], [invoice()]);
  assert.equal(d.actions[0].kind, "refused");
  assert.equal(d.actions[0].reason, "quote does not match the invoice line");
});

test("a quote that equals the line description is accepted", () => {
  const d = run([match("INV-1", 0, { quote: "Sichuan pepper pickle" })], [invoice()]);
  assert.equal(d.actions[0].kind, "refund_line");
});

test("an empty quote is refused", () => {
  assert.equal(quoteMatches("   ", line()), false);
});

// date window

test("the first and last day of the window are accepted", () => {
  const first = run([match("INV-1", 0)], [invoice({ invoiceDate: "2026-03-01" })]);
  const last = run([match("INV-1", 0)], [invoice({ invoiceDate: "2026-03-20" })]);
  assert.equal(first.actions[0].kind, "refund_line");
  assert.equal(last.actions[0].kind, "refund_line");
});

test("the day before and the day after the window are refused", () => {
  for (const date of ["2026-02-28", "2026-03-21"]) {
    const d = run([match("INV-1", 0)], [invoice({ invoiceDate: date })]);
    assert.equal(d.actions[0].kind, "refused", date);
    assert.equal(d.actions[0].reason, "outside the recall dates", date);
  }
});

test("an invoice date that is not an ISO date is refused as outside the window", () => {
  const d = run([match("INV-1", 0)], [invoice({ invoiceDate: "03/05/2026" })]);
  assert.equal(d.actions[0].reason, "outside the recall dates");
});

test("checkWindow rejects a range over 366 days and accepts exactly 366", () => {
  assert.equal(checkWindow("2026-01-01", "2027-01-01"), null);
  assert.match(checkWindow("2026-01-01", "2027-01-02") ?? "", /more than 366 days/);
});

test("checkWindow accepts a one day window", () => {
  assert.equal(checkWindow("2026-03-01", "2026-03-01"), null);
});

test("checkWindow rejects a start date after the end date", () => {
  assert.match(checkWindow("2026-03-20", "2026-03-01") ?? "", /after the end date/);
});

test("checkWindow rejects dates that do not exist or are malformed", () => {
  assert.match(checkWindow("2026-02-30", "2026-03-01") ?? "", /not valid dates/);
  assert.match(checkWindow("2026-03-01", "2026-13-01") ?? "", /not valid dates/);
  assert.match(checkWindow("March 1", "March 20") ?? "", /not valid dates/);
  assert.match(checkWindow("", "") ?? "", /not valid dates/);
});

test("decide stops with the window error and no actions for a bad window", () => {
  const d = run([match("INV-1", 0)], [invoice()], { from_date: "2026-02-30" });
  assert.equal(d.ok, false);
  assert.match(d.error ?? "", /not valid dates/);
  assert.deepEqual(d.actions, []);
});

// verdict

test("a lookalike verdict is refused and keeps the model reason", () => {
  const d = run([match("INV-1", 0, { verdict: "lookalike", reason: "salt, not the pickle" })], [invoice()]);
  assert.equal(d.actions[0].kind, "refused");
  assert.equal(d.actions[0].reason, "lookalike: salt, not the pickle");
});

test("a lookalike reason that names an amount is replaced", () => {
  const d = run([match("INV-1", 0, { verdict: "lookalike", reason: "costs $5 less" })], [invoice()]);
  assert.equal(d.actions[0].reason, "lookalike: the model named a similar product");
});

test("a missing verdict is refused", () => {
  const d = run([match("INV-1", 0, { verdict: "maybe" })], [invoice()]);
  assert.equal(d.actions[0].kind, "refused");
  assert.equal(d.actions[0].reason, "the model gave no verdict");
});

// cents

test("lineCents multiplies quantity by unit price and adds tax in integer cents", () => {
  assert.equal(lineCents({ quantity: "3", unitCents: 850, taxCents: 255 }), 2805);
});

test("lineCents handles a decimal quantity", () => {
  assert.equal(lineCents({ quantity: "1.5", unitCents: 850, taxCents: 0 }), 1275);
  assert.equal(lineCents({ quantity: "1.5", unitCents: 850, taxCents: 100 }), 1375);
});

test("lineCents returns NaN for a quantity it cannot read", () => {
  assert.ok(Number.isNaN(lineCents({ quantity: "two", unitCents: 850, taxCents: 0 })));
  assert.ok(Number.isNaN(lineCents({ quantity: "-1", unitCents: 850, taxCents: 0 })));
});

test("a line with an unreadable quantity is refused", () => {
  const inv = invoice({}, [line({ quantity: "two" }), line({ index: 1, itemId: "I1", name: "Other", description: "Other" })]);
  const d = run([match("INV-1", 0)], [inv]);
  assert.equal(d.actions[0].kind, "refused");
  assert.equal(d.actions[0].reason, "the line amount is not readable");
});

// refunds

test("a paid invoice refunds the line amount with tax", () => {
  const d = run([match("INV-1", 0)], [invoice()]);
  assert.equal(d.ok, true);
  assert.equal(d.actions[0].kind, "refund_line");
  assert.equal(d.actions[0].amountCents, 1870);
  assert.equal(d.refundCents, 1870);
  assert.equal(d.window?.from, "2026-03-01");
});

test("a refund is capped at the money still paid", () => {
  const d = run([match("INV-1", 0)], [invoice({ paidCents: 1000, refundedCents: 900 })]);
  assert.equal(d.actions[0].kind, "refund_line");
  assert.equal(d.actions[0].amountCents, 100);
  assert.match(d.actions[0].reason, /capped/);
});

test("two recalled lines on one invoice never refund more than the paid amount", () => {
  const inv = invoice({ paidCents: 2000, refundedCents: 0 }, [line({ index: 0, itemId: "I0" }), line({ index: 1, itemId: "I1" })]);
  const d = run([match("INV-1", 0), match("INV-1", 1)], [inv]);
  const refunds = d.actions.filter((a) => a.kind === "refund_line");
  assert.equal(refunds.length, 2);
  assert.equal(refunds.reduce((s, a) => s + a.amountCents, 0), 2000);
  assert.equal(d.refundCents, 2000);
});

test("an invoice with nothing left to refund is skipped as already refunded", () => {
  const d = run([match("INV-1", 0)], [invoice({ paidCents: 2570, refundedCents: 2570 })]);
  assert.equal(d.actions[0].kind, "skipped");
  assert.equal(d.actions[0].reason, "already refunded");
});

test("a line in refundedItems is skipped even when money is left", () => {
  const d = run([match("INV-1", 0)], [invoice()], {}, new Set(["I0"]));
  assert.equal(d.actions[0].kind, "skipped");
  assert.equal(d.actions[0].reason, "already refunded");
});

test("a REFUNDED invoice is skipped", () => {
  const d = run([match("INV-1", 0)], [invoice({ status: "REFUNDED" })]);
  assert.equal(d.actions[0].kind, "skipped");
  assert.equal(d.actions[0].reason, "already refunded");
});

test("a MARKED_AS_REFUNDED invoice (external payment fully refunded) is skipped", () => {
  const d = run([match("INV-1", 0)], [invoice({ status: "MARKED_AS_REFUNDED" })]);
  assert.equal(d.actions[0].kind, "skipped");
  assert.equal(d.actions[0].reason, "already refunded");
});

test("a CANCELLED invoice is skipped", () => {
  const d = run([match("INV-1", 0)], [invoice({ status: "CANCELLED" })]);
  assert.equal(d.actions[0].kind, "skipped");
  assert.equal(d.actions[0].reason, "the invoice is cancelled");
});

test("a status the rules do not handle is skipped with the status in the reason", () => {
  const d = run([match("INV-1", 0)], [invoice({ status: "PARTIALLY_PAID" })]);
  assert.equal(d.actions[0].kind, "skipped");
  assert.match(d.actions[0].reason, /PARTIALLY_PAID/);
});

// unpaid and draft

test("an UNPAID invoice pulls the line", () => {
  const d = run([match("INV-1", 0)], [invoice({ status: "UNPAID", paidCents: 0 })]);
  assert.equal(d.actions[0].kind, "pull_line");
  assert.equal(d.refundCents, 0);
});

test("a SENT invoice pulls the line", () => {
  const d = run([match("INV-1", 0)], [invoice({ status: "SENT", paidCents: 0 })]);
  assert.equal(d.actions[0].kind, "pull_line");
});

test("a DRAFT invoice edits the line", () => {
  const d = run([match("INV-1", 0)], [invoice({ status: "DRAFT", paidCents: 0 })]);
  assert.equal(d.actions[0].kind, "edit_draft_line");
});

test("an unpaid invoice with a single line is refused", () => {
  const inv = invoice({ status: "UNPAID", paidCents: 0 }, [line()]);
  const d = run([match("INV-1", 0)], [inv]);
  assert.equal(d.actions[0].kind, "refused");
  assert.match(d.actions[0].reason, /only line on the invoice/);
});

// match hygiene

test("a duplicate match is planned once", () => {
  const d = run([match("INV-1", 0), match("INV-1", 0)], [invoice()]);
  assert.equal(d.actions.length, 1);
});

test("a match for an unknown invoice id or line index is ignored", () => {
  const d = run([match("NOPE", 0), match("INV-1", 9), match("INV-1", 1.5), null, "text"], [invoice()]);
  assert.equal(d.ok, true);
  assert.deepEqual(d.actions, []);
});

test("a plan whose matches is not an array gives no actions", () => {
  const d = decide({ recallId: "R-1", plan: { ...plan([]), matches: "none" as unknown as unknown[] }, invoices: [invoice()] });
  assert.equal(d.ok, true);
  assert.deepEqual(d.actions, []);
});

test("work actions come first, then refused and skipped, in one stable order", () => {
  const draft = invoice({ id: "INV-D", status: "DRAFT", paidCents: 0 });
  const paid = invoice({ id: "INV-P" });
  const d = run([match("INV-D", 0), match("INV-P", 0, { verdict: "lookalike", reason: "salt" }), match("INV-P", 1, { quote: "Gundruk achar (jar, 250 g)" })], [draft, paid]);
  // The gundruk match also sweeps the gundruk line on the draft, so two draft edits appear.
  assert.deepEqual(d.actions.map((a) => a.kind), ["refund_line", "edit_draft_line", "edit_draft_line", "refused"]);
});

// name sweep

test("a same-name line the model left out is added by the name sweep and judged by the same rules", () => {
  const listed = invoice({ id: "INV-A", invoiceDate: "2026-03-05" });
  const outside = invoice({ id: "INV-B", invoiceDate: "2026-03-25" });
  const inside = invoice({ id: "INV-C", invoiceDate: "2026-03-10" });
  const d = run([match("INV-A", 0)], [listed, outside, inside]);
  const by = (id: string, idx: number) => d.actions.find((a) => a.invoiceId === id && a.lineIndex === idx)!;
  assert.equal(by("INV-A", 0).source, "model");
  assert.equal(by("INV-A", 0).kind, "refund_line");
  assert.equal(by("INV-B", 0).source, "name sweep");
  assert.equal(by("INV-B", 0).kind, "refused");
  assert.equal(by("INV-B", 0).reason, "outside the recall dates");
  assert.equal(by("INV-C", 0).source, "name sweep");
  assert.equal(by("INV-C", 0).kind, "refund_line");
  assert.equal(by("INV-C", 0).amountCents, 1870);
  assert.equal(d.actions.filter((a) => a.invoiceId === "INV-A" && a.lineIndex === 1).length, 0);
});

test("a lookalike match does not start the name sweep", () => {
  const listed = invoice({ id: "INV-A" });
  const other = invoice({ id: "INV-B" });
  const d = run([match("INV-A", 0, { verdict: "lookalike", reason: "salt" })], [listed, other]);
  assert.equal(d.actions.length, 1);
  assert.equal(d.actions[0].source, "model");
  assert.equal(d.actions[0].kind, "refused");
});

test("a match with a wrong quote does not start the name sweep", () => {
  const d = run([match("INV-A", 0, { quote: "wrong" })], [invoice({ id: "INV-A" }), invoice({ id: "INV-B" })]);
  assert.equal(d.actions.length, 1);
  assert.equal(d.actions[0].kind, "refused");
});

// hash

test("planHash is stable for the same input", () => {
  const inv = invoice();
  const a = run([match("INV-1", 0)], [inv]);
  const b = run([match("INV-1", 0)], [structuredClone(inv)]);
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{16}$/);
});

test("planHash changes when the invoice status changes", () => {
  const a = run([match("INV-1", 0)], [invoice({ status: "MARKED_AS_PAID" })]);
  const b = run([match("INV-1", 0)], [invoice({ status: "PAID" })]);
  assert.equal(a.actions[0].kind, b.actions[0].kind);
  assert.notEqual(a.hash, b.hash);
});

test("planHash changes when paidCents changes", () => {
  const a = run([match("INV-1", 0)], [invoice({ paidCents: 2570 })]);
  const b = run([match("INV-1", 0)], [invoice({ paidCents: 3000 })]);
  assert.equal(a.actions[0].amountCents, b.actions[0].amountCents);
  assert.notEqual(a.hash, b.hash);
});

test("planHash ignores invoices the plan did not touch", () => {
  const touched = invoice();
  const other = invoice({ id: "INV-2" });
  const acts = run([match("INV-1", 0)], [touched]).actions;
  assert.equal(planHash(acts, [touched]), planHash(acts, [touched, other]));
});

// execute gate

test("checkExecute asks for confirm, then the right hash", () => {
  assert.deepEqual(checkExecute("abc", "abc", undefined), { ok: false, status: 400, error: "Tick 'I reviewed the dry run' to confirm, then run the recall." });
  assert.equal((checkExecute("abc", "abc", "true") as { status: number }).status, 400);
  assert.equal((checkExecute("abc", "zzz", true) as { status: number }).status, 409);
  assert.equal((checkExecute("abc", undefined, true) as { status: number }).status, 409);
  assert.deepEqual(checkExecute("abc", "abc", true), { ok: true });
});

// caps

test("more than MAX_ACTIONS work actions stops the plan and names the limit", () => {
  const invoices = Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => invoice({ id: `D-${i}`, status: "DRAFT", paidCents: 0 }));
  const d = run(invoices.map((inv) => match(inv.id, 0)), invoices);
  assert.equal(d.ok, false);
  assert.match(d.error ?? "", new RegExp(`The limit is ${MAX_ACTIONS}`));
  assert.deepEqual(d.actions, []);
});

test("exactly MAX_ACTIONS work actions is allowed", () => {
  const invoices = Array.from({ length: MAX_ACTIONS }, (_, i) => invoice({ id: `D-${i}`, status: "DRAFT", paidCents: 0 }));
  const d = run(invoices.map((inv) => match(inv.id, 0)), invoices);
  assert.equal(d.ok, true);
  assert.equal(d.actions.length, MAX_ACTIONS);
});

test("refunds over MAX_REFUND_CENTS stop the plan", () => {
  const big = line({ quantity: "1", unitCents: MAX_REFUND_CENTS + 1, taxCents: 0 });
  const inv = invoice({ paidCents: MAX_REFUND_CENTS + 1000 }, [big, line({ index: 1, itemId: "I1" })]);
  const d = run([match("INV-1", 0)], [inv]);
  assert.equal(d.ok, false);
  assert.match(d.error ?? "", /\$50,000\.00 for one recall/);
});

// notice

test("a template with a dollar amount is replaced by the default template", () => {
  const d = run([match("INV-1", 0)], [invoice()], { notice_template: "Dear {buyer}, enjoy $5 off {item}. {refund}" });
  assert.equal(d.templateRejected, true);
  assert.ok(d.actions[0].notice?.startsWith("Dear Asha Gurung, we are recalling Timur achar (jar, 250 g)"));
  assert.ok(!d.actions[0].notice?.includes("$5 off"));
});

test("a template that is empty is replaced by the default template", () => {
  const d = run([match("INV-1", 0)], [invoice()], { notice_template: "" });
  assert.equal(d.templateRejected, true);
});

test("a hazard that names an amount also rejects the template", () => {
  const d = run([match("INV-1", 0)], [invoice()], { hazard: "refund of 5$ due" });
  assert.equal(d.templateRejected, true);
});

test("the notice carries the server formatted refund amount", () => {
  const d = run([match("INV-1", 0)], [invoice()], { notice_template: "Dear {buyer}, {item} on {order}. {refund}" });
  assert.equal(d.templateRejected, false);
  assert.equal(d.actions[0].notice, "Dear Asha Gurung, Timur achar (jar, 250 g) on 0001. We recorded a refund of $18.70 for this item.");
});

test("the default template carries the server formatted refund amount", () => {
  const d = run([match("INV-1", 0)], [invoice()], { notice_template: "Only $5 today" });
  assert.match(d.actions[0].notice ?? "", /\$18\.70/);
  assert.equal(d.actions[0].notice, fillNotice(DEFAULT_TEMPLATE, { buyer: "Asha Gurung", order: "0001", item: NAME, refund: "We recorded a refund of $18.70 for this item." }));
});

test("a refused or skipped action has no notice", () => {
  const d = run([match("INV-1", 0, { quote: "wrong" })], [invoice()]);
  assert.equal(d.actions[0].notice, null);
});

test("a buyer with no name falls back to the email in the notice", () => {
  const d = run([match("INV-1", 0)], [invoice({ buyer: "" })]);
  assert.ok(d.actions[0].notice?.startsWith("Dear asha@example.com"));
});

test("hasMoney finds currency symbols and codes next to digits", () => {
  for (const text of ["$ 5", "$5", "5€", "Rs 100", "Rs.100", "USD 5", "NPR 40", "£3"]) assert.equal(hasMoney(text), true, text);
});

test("hasMoney ignores plain numbers", () => {
  for (const text of ["order 0042", "250 g jar", "March 1 to March 20", ""]) assert.equal(hasMoney(text), false, text);
});

test("hasMoney finds a code written after the number", () => {
  assert.equal(hasMoney("5 USD"), true);
  assert.equal(hasMoney("100 NPR"), true);
});

test("fillNotice fills every placeholder, repeats included", () => {
  const out = fillNotice("{buyer}|{order}|{item}|{refund}|{buyer}|{unknown}", { buyer: "B", order: "O", item: "I", refund: "R" });
  assert.equal(out, "B|O|I|R|B|{unknown}");
});
