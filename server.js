import express from "express";
import cors from "cors";
import multer from "multer";
import { getAIResponse, providerStatus, transcribeAudio, streamAIResponse } from "./lib/providers.js";

const app = express();
const PORT = process.env.PORT || 10000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB — plenty for a spoken answer
});

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


// Lightweight in-memory request guard. It is intentionally dependency-free and
// complements (rather than replaces) proper platform-level rate limiting.
const rateBuckets = new Map();
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000);
const RATE_MAX = Number(process.env.RATE_MAX || 60);
app.use((req, res, next) => {
  if (!req.path.startsWith("/chat") && !req.path.startsWith("/evaluate") && !req.path.startsWith("/transcribe")) return next();
  const key = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { start: now, count: 0 };
  if (now - bucket.start >= RATE_WINDOW_MS) { bucket.start = now; bucket.count = 0; }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > RATE_MAX) return res.status(429).json({ error: "Too many requests. Please slow down and try again." });
  next();
});

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

// ─────────────────────────────────────────────────────────
// POST /transcribe
// multipart/form-data, field name: "audio"
// Response: { text, duration, language }
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// POST /chat/stream
// SSE streaming companion to /chat. The original /chat endpoint is unchanged.
// ─────────────────────────────────────────────────────────
app.post("/chat/stream", async (req, res) => {
  try {
    const { messages, system } = req.body || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages (non-empty array) is required" });
    }

    const fullMessages = system ? [{ role: "system", content: system }, ...messages] : messages;
    const result = await streamAIResponse(fullMessages);

    if (!result) {
      return res.status(503).json({ error: "AI is temporarily unavailable. Please try again." });
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ type: "meta", provider: result.provider, model: result.model });

    let content = "";
    for await (const chunk of result.stream) {
      if (!chunk) continue;
      content += chunk;
      send({ type: "delta", content: chunk });
    }

    send({ type: "done", content });
    res.end();
  } catch (err) {
    console.error("STREAM CHAT ERROR:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Something went wrong on our end. Please try again." });
    }
    res.write(`data: ${JSON.stringify({ type: "error", error: "Something went wrong on our end. Please try again." })}\n\n`);
    res.end();
  }
});

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    const file = req.file;
    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(400).json({ error: "No audio received. Please try recording again." });
    }
    // A few hundred bytes of webm/ogg container with no real speech —
    // reject before spending a transcription call on it.
    if (file.buffer.length < 800) {
      return res.status(400).json({ error: "Recording was too short. Please try again." });
    }

    const result = await transcribeAudio(file.buffer, file.originalname, file.mimetype);

    if (!result) {
      return res.status(503).json({ error: "Couldn't understand that recording. Please try again." });
    }
    if (!result.text) {
      return res.status(400).json({ error: "Couldn't understand that recording. Please try again." });
    }

    return res.json(result);
  } catch (err) {
    console.error("TRANSCRIBE ERROR:", err);
    return res.status(500).json({ error: "Couldn't understand that recording. Please try again." });
  }
});

// ─────────────────────────────────────────────────────────
// POST /evaluate
// Body (single answer):  { mode: "answer", question, answer }
// Body (final report):   { mode: "final", transcript: [{role, content}, ...] }
// ─────────────────────────────────────────────────────────
const ANSWER_EVAL_PROMPT = `You are a strict but fair technical interview coach reviewing a single answer from a practice session. Respond with ONLY a raw JSON object, no markdown fences, no commentary, matching exactly this shape:
{
  "scores": { "technical_accuracy": 0-10, "clarity": 0-10, "structure": 0-10, "confidence": 0-10, "relevance": 0-10, "completeness": 0-10, "communication": 0-10 },
  "good": "1-2 sentences on what was good",
  "missing": "1-2 sentences on what was missing, or empty string if nothing",
  "mistakes": "1-2 sentences on technical mistakes, or empty string if none",
  "improve": "1-2 sentences of concrete improvement advice",
  "stronger_example": "a short example of a stronger answer to the same question"
}
Only include a field's content if there's something real to say; use empty string for good/missing/mistakes/improve/stronger_example when not applicable. Every score field is required.`;

const FINAL_EVAL_PROMPT = `You are a strict but fair technical interview coach producing a final report for a completed practice interview. You'll receive the full transcript. Respond with ONLY a raw JSON object, no markdown fences, no commentary, matching exactly this shape:
{
  "overall_score": 0-100,
  "categories": {
    "technical_knowledge": 0-10, "javascript": 0-10, "html_css": 0-10, "react": 0-10,
    "apis_backend": 0-10, "problem_solving": 0-10, "system_thinking": 0-10,
    "communication": 0-10, "ui_ux": 0-10, "project_knowledge": 0-10, "confidence_clarity": 0-10
  },
  "strong_areas": ["short phrase", "..."],
  "weak_areas": ["short phrase", "..."],
  "questions_missed": ["short description", "..."],
  "technical_corrections": ["short correction", "..."],
  "recommended_topics": ["topic", "..."],
  "suggested_practice_plan": "2-4 sentence plan"
}
Only score a category if the transcript actually touched on it; otherwise give it a neutral 5 rather than guessing wildly. Arrays can be empty if genuinely not applicable, but try to give useful, specific content — no filler.`;

function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

app.post("/evaluate", async (req, res) => {
  try {
    const { mode, question, answer, transcript } = req.body || {};

    let systemPrompt, userContent;

    if (mode === "final") {
      if (!Array.isArray(transcript) || transcript.length === 0) {
        return res.status(400).json({ error: "transcript (non-empty array) is required for a final report" });
      }
      systemPrompt = FINAL_EVAL_PROMPT;
      userContent = transcript.map((m) => `${m.role === "assistant" ? "Interviewer" : "Candidate"}: ${m.content}`).join("\n\n");
    } else {
      if (!question || !answer) {
        return res.status(400).json({ error: "question and answer are required" });
      }
      systemPrompt = ANSWER_EVAL_PROMPT;
      userContent = `Question: ${question}\n\nAnswer: ${answer}`;
    }

    const result = await getAIResponse([
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ]);

    if (!result) {
      return res.status(503).json({ error: "AI is temporarily unavailable. Please try again." });
    }

    const parsed = parseJsonLoose(result.content);
    if (!parsed) {
      return res.status(502).json({ error: "Couldn't generate a report right now. Please try again." });
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
