# Data model

## Invoice and line

`Invoice` (in `src/gateway.ts`) holds `id`, `number`, `status`, `invoiceDate`, `buyer`, `email`, `reference`, `totalCents`, `paidCents`, `refundedCents`, `payerUrl` and `lines`.

`Line` holds `itemId`, `name`, `description`, `quantity`, `unitCents`, `taxPercent` and `taxCents`. All money is in integer cents.

## Action

`decide` in `src/rules.ts` makes one `Action` for each proposed line. The `kind` is one of:

| Kind | Meaning |
| --- | --- |
| `refund_line` | Paid invoice. Refund the amount of this line. |
| `pull_line` | Sent unpaid invoice. Remove the line with `PUT`. |
| `edit_draft_line` | Draft invoice. Remove the line with `PUT`. |
| `refused` | A rule stopped the line. The `reason` says which rule. |
| `skipped` | The line is already done or the invoice is cancelled or refunded. |

The action key is `recallId:invoiceId:itemId`.

## Rules

| Rule | Result |
| --- | --- |
| The quote is not the line name or description (whitespace collapsed, case kept) | Refused: "quote does not match the invoice line" |
| The invoice date is outside the window (both edges are inside) | Refused: "outside the recall dates" |
| The window is longer than 366 days or not valid | The dry run stops with an error |
| The model verdict is `lookalike` | Refused, with the model reason |
| A line has the same name as a verified recalled line, but the model did not list it | The server adds it, and the same rules decide it |
| Amount | Quantity times unit price plus line tax, in integer cents from PayPal data |
| Paid invoice | Refund the line, at most the paid amount minus earlier refunds |
| Nothing left to refund, or the line is in the ledger | Skipped: "already refunded" |
| The recalled line is the only line on an unpaid invoice | Refused. Cancel the invoice in PayPal. |
| Execute | Needs the hash of the dry run and `confirm: true`. If PayPal data changed, the server makes a new dry run and runs nothing. |
| Caps | At most 200 actions and $50,000 of refunds for one recall |
| Notice | The server fills `{buyer}`, `{order}`, `{item}` and `{refund}`. A model template with an amount is replaced by the server template. |

## Ledger

The ledger is a JSON file of `{recallId, action, paypalId, at}` entries: `ledger.json`, or `ledger-<set>.json` for a demo set. It is gitignored.

## Seed data

18 invoices for Himal Pickles, with reference `lot-recall-demo` and a key `seed:lr-<set><nn>` in the note:

- 9 paid, 3 sent and unpaid, and 2 draft invoices with Timur achar from March 1 to March 20.
- 2 invoices with Timur salt, a lookalike product.
- 2 invoices with Timur achar from outside the dates.

`LOT_RECALL_SET` picks a fresh set of letters, because a recall changes the set.

## Settings

| Variable | Use |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal sandbox REST app. Empty means mock mode. |
| `AI_API_KEY` | Key for an OpenAI-compatible API. |
| `AI_BASE_URL` | Default `https://api.groq.com/openai/v1`. |
| `AI_MODEL` | Default `openai/gpt-oss-120b`. |
| `AI_STT_MODEL` | Default `whisper-large-v3-turbo`. |
| `PORT_LOT_RECALL` | Default `3004`. |
| `LOT_RECALL_SET` | Demo set letters. Empty is the first set. |
