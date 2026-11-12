# Components

| File | Role |
| --- | --- |
| `src/main.ts` | Reads the settings, picks the PayPal sandbox gateway or the mock gateway, and starts the server. |
| `src/server.ts` | Express routes, recalls in memory, the ledger file, and the execute step. |
| `src/gateway.ts` | `Gateway` interface. `paypalSandboxGateway` calls Invoicing v2. `mockGateway` keeps invoices in memory for tests and for runs without keys. |
| `src/agent.ts` | Prompts, `planRecall` (batches of 80 lines), `openAiCompatModel` (JSON mode, one retry) and `whisperTranscriber`. |
| `src/rules.ts` | `decide` turns the model plan into actions. Also the quote check, the date window, line cents, notice fill, `planHash` and `checkExecute`. |
| `src/seed-data.ts` | 18 demo invoices for the made-up seller Himal Pickles. |
| `scripts/seed.ts` | Creates, sends and pays the demo invoices in the sandbox. A second run creates nothing. |
| `public/index.html` | The single page: sentence, voice note upload, dry run grid (AG Grid Community), confirm, results, notices, server log. |
| `test/*.test.ts` | Tests for rules, gateway, agent and server. They use a fake model, a fake fetch and the mock gateway. |
