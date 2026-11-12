# Lot Recall

Lot Recall helps a small food maker recall one bad batch from PayPal invoices. The seller types or says one sentence, for example: "The timur achar made between March 1 and March 20 may contain peanuts." The app shows a dry run of every refund and invoice edit. After the seller confirms, the app runs the actions in PayPal.

## Honest framing

- The app uses the PayPal sandbox. No buyer logs in during the demo.
- The seed records each payment as an external payment (`BANK_TRANSFER`). Each refund is also an external refund. No sandbox money moves.
- The buyer notices are previews. The app sends no email.

## How it works

1. The seller types one sentence or uploads a voice note. Whisper turns the voice note into text.
2. The server reads the demo invoices from PayPal, with all lines.
3. The AI model finds the lines that are the product, and the lines that only look similar. It also reads the date window.
4. The rule engine checks each proposed line in code and decides the action. The model does not decide amounts.
5. The page shows the dry run. The seller ticks "I reviewed the dry run" and clicks "Confirm and run".
6. The server refunds paid lines, removes lines from unpaid and draft invoices, and writes each line to a ledger. A second run changes nothing.

## How PayPal is used

Invoicing v2 only. No Payouts and no transfer API.

| Call | Use |
| --- | --- |
| `POST /v1/oauth2/token` | Get the access token. |
| `POST /v2/invoicing/search-invoices` | Find invoices with reference `lot-recall-demo`. The result has no lines. |
| `GET /v2/invoicing/invoices/{id}` | Read each invoice with its lines, tax, payments and refunds. |
| `POST /v2/invoicing/invoices` | Seed: create an invoice with `detail.reference` and `detail.invoice_date`. |
| `POST /v2/invoicing/invoices/{id}/send` | Seed: send with `send_to_recipient: false`. |
| `POST /v2/invoicing/invoices/{id}/payments` | Seed: record an external payment. |
| `POST /v2/invoicing/invoices/{id}/refunds` | Refund the amount of one line. |
| `PUT /v2/invoicing/invoices/{id}` | Remove one line from an unpaid or draft invoice. |

Sandbox facts that we tested:

- `PUT` works on `DRAFT` and on sent `UNPAID` invoices. The body must not contain `amount`, item ids or tax amounts. Otherwise PayPal answers `400 calculation_error`. A sent invoice changes to status `SENT` after the edit. Cancel and reissue is not necessary.
- A partial refund changes the status to `PARTIALLY_REFUNDED`. A full refund of an external payment gives `MARKED_AS_REFUNDED`.
- PayPal created a second refund when we sent the same `PayPal-Request-Id` with a different amount. The local ledger file is the guard against a second refund.

## How AI is used

- `openai/gpt-oss-120b` on Groq, in JSON mode, reads the sentence and up to 80 invoice lines for each call. It returns the product, the dates, the hazard, the matches with a verdict (`recalled` or `lookalike`) and a notice template.
- `whisper-large-v3-turbo` on Groq turns a voice note into text. The server gives Whisper the item names, so it spells "Timur achar" correctly.
- The server retries one time when the reply is not valid JSON.

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
| Sent unpaid invoice | Remove the line with `PUT` |
| Draft invoice | Remove the line with `PUT` |
| Cancelled or refunded invoice | Skipped, with the reason |
| The recalled line is the only line on an unpaid invoice | Refused. Cancel the invoice in PayPal. |
| Each recall, invoice and line | Runs one time. The ledger answers "already done". |
| Execute | Needs the hash of the dry run and `confirm: true`. If PayPal data changed, the server makes a new dry run and runs nothing. |
| Caps | At most 200 actions and $50,000 of refunds for one recall |
| Notice | The server fills `{buyer}`, `{order}`, `{item}` and `{refund}`. A model template with an amount is replaced by the server template. |

## Run

```
npm install
cp .env.example .env
npm run build
npm run seed
npm start
```

Open http://localhost:3004. Without PayPal keys, the server uses the mock gateway with the same seed data, and the page shows MOCK. Without `AI_API_KEY`, the dry run is not available.

Run the seed one time for each demo set. A second run creates nothing. To start again with fresh invoices, use a new set:

```
LOT_RECALL_SET=e npm run seed
LOT_RECALL_SET=e npm start
```

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

## Routes

| Route | Use |
| --- | --- |
| `GET /api/config` | Mode, model and sample sentence. |
| `POST /api/recalls/preview` | `{sentence}` or `{audioBase64, audioType}`. Returns the dry run. |
| `POST /api/recalls/:id/execute` | `{planHash, confirm: true}`. Runs the actions. |
| `GET /api/recalls/:id` | Actions with live PayPal status. |
| `GET /api/ledger` | All done actions with live invoice status. |
| `GET /api/seed-status` | Demo invoices by status. |
| `GET /api/log` | The server log. |

## Tests

```
npm test
```

The tests use a fake model, a fake fetch and the mock gateway. They make no network call.

## Honest limits

- No money moves. Payments and refunds are external records in the sandbox.
- The notices are previews. The app sends no email.
- Recalls stay in server memory. A restart forgets the dry runs. The ledger file (`ledger.json`, or `ledger-<set>.json` for a demo set) keeps the done actions.
- The app uses the invoice date as the batch date.
- English only.
- This is not legal advice. It does not replace the recall process of a food regulator.

## License

MIT. See `LICENSE`.
