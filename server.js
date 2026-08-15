
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

// ─────────────────────────────────────────────
// POST /evaluate
// Body: { question: string, answer: string }
// Response: { scores: {...0-10}, good, missing, mistakes, improve, stronger_example }
// ─────────────────────────────────────────────
const EVALUATOR_SYSTEM_PROMPT = `You are an experienced technical interviewer reviewing one answer from an early-career frontend developer's practice interview. Be honest and specific, not automatically generous — this only helps him if it's accurate.

Score these 0-10 as integers: technical_accuracy, clarity, structure, confidence, relevance, completeness, communication.

Then give: what was good (1-2 sentences), what was missing (1-2 sentences), technical_mistakes (empty string if none), how to improve (1-2 sentences), and a stronger_example answer written the way a calm, honest junior developer would actually say it out loud — not corporate, not overly polished, still realistic for his level.

Respond with ONLY a single JSON object, no markdown fences, no preamble, in exactly this shape:
{"scores":{"technical_accuracy":0,"clarity":0,"structure":0,"confidence":0,"relevance":0,"completeness":0,"communication":0},"good":"","missing":"","mistakes":"","improve":"","stronger_example":""}`;

app.post("/evaluate", async (req, res) => {
  try {
    const { question, answer } = req.body || {};
    if (!answer || typeof answer !== "string") {
      return res.status(400).json({ error: "answer (string) is required" });
    }

    const userContent = `INTERVIEW QUESTION:\n${question || "(not provided)"}\n\nCANDIDATE'S ANSWER:\n${answer}`;

    const result = await getAIResponse([
      { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ]);

    if (!result) {
      return res.json({
        error: "AI is temporarily unavailable. Please try reviewing this answer again in a moment.",
      });
    }

    let parsed;
    try {
      const cleaned = result.content.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.log("Evaluate: failed to parse JSON, returning raw content");
      return res.json({
        error: "Couldn't parse the evaluation. Please try again.",
        raw: result.content,
      });
    }

    return res.json(parsed);
  } catch (err) {
    console.error("EVALUATE ERROR:", err);
    return res.status(500).json({ error: "Something went wrong on our end. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Codex Interview AI backend running on port ${PORT}`);
  console.log("📌 Provider status:", providerStatus());
});
