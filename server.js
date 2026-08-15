import express from "express";
import cors from "cors";
import { getAIResponse, providerStatus } from "./lib/providers.js";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "2mb" }));

// Comma-separated list in env, e.g. ALLOWED_ORIGINS=https://your-frontend.vercel.app,http://localhost:5173
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // No origin (curl/Postman/server-to-server) is allowed through.
      // If ALLOWED_ORIGINS is left empty, allow all — useful for local dev,
      // but set it in production so CORS is actually restrictive.
      if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS blocked"));
      }
    },
  })
);

// ─────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    providers: providerStatus(),
  });
});

// ─────────────────────────────────────────────────────────
// POST /chat
// Body: { messages: [{role, content}, ...], system?: string }
// Response: { content, provider, model }
// ─────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { messages, system } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages (non-empty array) is required" });
    }

    const fullMessages = system ? [{ role: "system", content: system }, ...messages] : messages;

    const result = await getAIResponse(fullMessages);

    if (!result) {
      // All providers exhausted — respond 200 with a friendly message so the
      // frontend can just render it, rather than having to special-case an error.
      return res.json({
        content: "AI is temporarily unavailable. Please try again in a moment.",
        provider: null,
        model: null,
      });
    }

    return res.json(result);
  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({
      content: "Something went wrong on our end. Please try again.",
      provider: null,
      model: null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Codex Interview AI backend running on port ${PORT}`);
  console.log("📌 Provider status:", providerStatus());
});
