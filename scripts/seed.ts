// Creates the 18 Himal Pickles demo invoices in the PayPal sandbox.
// Usage: npm run seed. A second run creates nothing: each invoice note carries its seed key.
import { paypalSandboxGateway, SEED_SET, SEED_TAG, type Trace } from "../src/gateway.js";
import { formatUsd, lineCents } from "../src/rules.js";
import { SEED } from "../src/seed-data.js";

const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set. Without them the server uses the mock gateway and needs no seed.");
  process.exit(1);
}
const gw = paypalSandboxGateway(clientId, clientSecret);
let calls = 0;
const trace: Trace = () => calls++;

const existing = await gw.listDemo(trace);
const keyOf = (note: string) => (note.match(new RegExp(`${SEED_TAG}${SEED_SET}\\d{2}\\b`)) ?? [""])[0];
const have = new Map(existing.map((inv) => [keyOf(inv.note), inv]));
const rows: string[][] = [];

for (const s of SEED) {
  let inv = have.get(s.key);
  let made = "exists";
  if (!inv) {
    const id = await gw.create(s.invoice, trace);
    if (s.state !== "DRAFT") await gw.send(id, trace);
    if (s.state === "PAID") {
      const sent = await gw.get(id, trace);
      const next = new Date(Date.parse(`${s.invoice.invoiceDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      await gw.recordPayment(id, sent.totalCents, next, trace);
    }
    inv = await gw.get(id, trace);
    made = "created";
  }
  const total = inv.lines.reduce((sum, l) => sum + lineCents(l), 0);
  rows.push([s.key, made, inv.number, inv.id, inv.invoiceDate, inv.status, formatUsd(total), inv.lines.map((l) => `${l.quantity}x ${l.name}`).join(" + "), s.role]);
}

const head = ["seed key", "run", "number", "invoice id", "date", "status", "total", "lines", "role"];
const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const fmt = (r: string[]) => r.map((c, i) => c.padEnd(width[i])).join(" | ");
console.log(fmt(head));
console.log(width.map((w) => "-".repeat(w)).join("-|-"));
for (const r of rows) console.log(fmt(r));
console.log(`${rows.filter((r) => r[1] === "created").length} created, ${rows.filter((r) => r[1] === "exists").length} already there, ${calls} PayPal calls`);
