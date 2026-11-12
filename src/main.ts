import { openAiCompatModel, whisperTranscriber } from "./agent.js";
import { mockGateway, paypalSandboxGateway, SEED_SET } from "./gateway.js";
import { SEED } from "./seed-data.js";
import { createApp } from "./server.js";

const port = Number(process.env.PORT_LOT_RECALL || 3004);
const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

const gateway = clientId && clientSecret ? paypalSandboxGateway(clientId, clientSecret) : mockGateway(SEED.map((s) => s.invoice), SEED.map((s) => s.state));
const ai = process.env.AI_API_KEY
  ? {
      apiKey: process.env.AI_API_KEY,
      baseUrl: process.env.AI_BASE_URL || "https://api.groq.com/openai/v1",
      model: process.env.AI_MODEL || "openai/gpt-oss-120b",
      sttModel: process.env.AI_STT_MODEL || "whisper-large-v3-turbo",
    }
  : null;
const model = ai ? openAiCompatModel(ai) : null;
const transcriber = ai ? whisperTranscriber(ai) : null;

// The ledger file is per demo set, so a fresh LOT_RECALL_SET starts with an empty ledger. Mock mode keeps it in memory.
const ledgerFile = gateway.mode === "sandbox" ? `ledger${SEED_SET ? `-${SEED_SET}` : ""}.json` : null;

createApp({ gateway, model, transcriber, ledgerFile }).listen(port, () => {
  const payments = gateway.mode === "mock" ? "MOCK gateway, no PayPal keys" : "PayPal sandbox";
  console.log(`listening on http://localhost:${port} (${payments}, model ${model?.label ?? "not configured"})`);
});
