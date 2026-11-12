// Demo data for the fictional Himal Pickles. All names and emails are made up.
import { SEED_SET, SEED_TAG, type NewInvoice, type NewLine } from "./gateway.js";

export type SeedState = "PAID" | "SENT" | "DRAFT";
export type SeedRow = { key: string; state: SeedState; role: string; invoice: NewInvoice };

const TIMUR = "Timur achar (jar, 250 g)";
const timur = (q: number): NewLine => ({ name: TIMUR, description: "Sichuan pepper pickle, small batch", quantity: q, unitCents: 850, taxPercent: "10" });
const gundruk = (q: number): NewLine => ({ name: "Gundruk achar (jar, 250 g)", description: "Fermented greens pickle", quantity: q, unitCents: 700 });
const lapsi = (q: number): NewLine => ({ name: "Lapsi candy (box, 12 pieces)", description: "Hog plum sweets", quantity: q, unitCents: 450 });
const salt: NewLine = { name: "Timur salt (pouch, 100 g)", description: "Sea salt with ground timur pepper", quantity: 2, unitCents: 500 };

const BUYERS = [
  "Asha Gurung", "Bikash Rai", "Chandra Thapa", "Dipa Shrestha", "Eklal Magar", "Furba Sherpa",
  "Gita Karki", "Hari Basnet", "Indira Lama", "Jivan Tamang", "Kamala Bhatt", "Laxman Joshi",
  "Maya Pandey", "Nabin Khadka", "Ojaswi Rana", "Prakash Adhikari", "Rita Bista", "Sanjay Poudel",
];

const plan: [SeedState, string, string, NewLine[]][] = [
  ["PAID", "2026-03-01", "recall, paid, first day of the window", [timur(2), gundruk(1)]],
  ["PAID", "2026-03-03", "recall, paid", [timur(1), lapsi(2)]],
  ["PAID", "2026-03-05", "recall, paid", [gundruk(2), timur(3)]],
  ["PAID", "2026-03-07", "recall, paid", [timur(1), lapsi(1), gundruk(1)]],
  ["PAID", "2026-03-09", "recall, paid", [timur(2), lapsi(3)]],
  ["PAID", "2026-03-12", "recall, paid", [lapsi(1), timur(1)]],
  ["PAID", "2026-03-14", "recall, paid", [timur(4), gundruk(1)]],
  ["PAID", "2026-03-17", "recall, paid", [timur(1), gundruk(2)]],
  ["PAID", "2026-03-20", "recall, paid, last day of the window", [timur(2), lapsi(1)]],
  ["SENT", "2026-03-06", "recall, sent and unpaid", [timur(2), gundruk(1)]],
  ["SENT", "2026-03-13", "recall, sent and unpaid", [lapsi(2), timur(1)]],
  ["SENT", "2026-03-18", "recall, sent and unpaid", [timur(3), lapsi(1)]],
  ["DRAFT", "2026-03-10", "recall, draft", [timur(1), gundruk(1)]],
  ["DRAFT", "2026-03-19", "recall, draft", [gundruk(1), timur(2)]],
  ["PAID", "2026-03-08", "decoy, timur salt", [salt, lapsi(1)]],
  ["PAID", "2026-02-26", "decoy, before the window", [timur(1), gundruk(1)]],
  ["PAID", "2026-03-24", "decoy, after the window", [timur(2), lapsi(1)]],
  ["SENT", "2026-03-11", "decoy, timur salt", [salt, gundruk(1)]],
];

export const SEED: SeedRow[] = plan.map(([state, date, role, lines], i) => {
  const n = String(i + 1).padStart(2, "0");
  const key = `${SEED_TAG}${SEED_SET}${n}`;
  return {
    key,
    state,
    role,
    invoice: {
      invoiceDate: date,
      buyer: BUYERS[i],
      email: `buyer${n}@example.com`,
      note: `Himal Pickles order ${n}. Demo data (${key}).`,
      lines,
    },
  };
});

export const SAMPLE_SENTENCE = "The timur achar made between March 1 and March 20 may contain peanuts.";
