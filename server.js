import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { getAIResponse, streamAIResponse, providerStatus, transcribeAudio } from "./lib/providers.js";

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const origins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: (origin, cb) => {
  if (!origin || origins.length === 0 || origins.includes(origin)) return cb(null, true);
  cb(new Error("CORS blocked"));
}}));

const limiter = rateLimit({ windowMs: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MINUTE || 60), standardHeaders: true, legacyHeaders: false });
app.use(["/chat", "/chat/stream", "/transcribe", "/evaluate"], limiter);

app.get("/health", (_req, res) => res.json({ status: "ok", version: "2.0.0", timestamp: new Date().toISOString(), providers: providerStatus() }));

function validateMessages(messages) {
  return Array.isArray(messages) && messages.length > 0 && messages.length <= 80 && messages.every(m => m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string");
}

app.post("/chat", async (req, res) => {
  try {
    const { messages, system } = req.body || {};
    if (!validateMessages(messages)) return res.status(400).json({ error: "messages must be a non-empty valid array (max 80)" });
    const full = system ? [{ role: "system", content: system }, ...messages] : messages;
    const result = await getAIResponse(full);
    if (!result) return res.status(503).json({ error: "AI is temporarily unavailable. Please try again." });
    res.json(result);
  } catch (err) {
    console.error("CHAT ERROR", err);
    res.status(500).json({ error: "Something went wrong on our end." });
  }
});

// Server-sent events endpoint for low-latency streamed text responses.
app.post("/chat/stream", async (req, res) => {
  try {
    const { messages, system } = req.body || {};
    if (!validateMessages(messages)) return res.status(400).json({ error: "messages must be a non-empty valid array (max 80)" });
    const full = system ? [{ role: "system", content: system }, ...messages] : messages;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let closed = false;
    req.on("close", () => { closed = true; });
    const send = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const result = await streamAIResponse(full, chunk => send("token", { text: chunk }));
    if (!result) send("error", { error: "AI is temporarily unavailable. Please try again." });
    else send("done", result);
    if (!closed) res.end();
  } catch (err) {
    console.error("STREAM ERROR", err);
    if (!res.headersSent) return res.status(500).json({ error: "Streaming failed." });
    res.write(`event: error\ndata: ${JSON.stringify({ error: "Streaming failed. Please try again." })}\n\n`);
    res.end();
  }
});

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer?.length) return res.status(400).json({ error: "No audio received." });
    if (file.buffer.length < 800) return res.status(400).json({ error: "Recording was too short." });
    const result = await transcribeAudio(file.buffer, file.originalname, file.mimetype);
    if (!result?.text) return res.status(503).json({ error: "Couldn't understand that recording." });
    res.json(result);
  } catch (err) {
    console.error("TRANSCRIBE ERROR", err);
    res.status(500).json({ error: "Couldn't understand that recording." });
  }
});

const ANSWER_EVAL_PROMPT = `You are a strict but fair technical interview coach. Return ONLY valid JSON with this exact shape: {"scores":{"technical_accuracy":0,"clarity":0,"structure":0,"confidence":0,"relevance":0,"completeness":0,"communication":0},"good":"","missing":"","mistakes":"","improve":"","stronger_example":""}. Score 0-10. Never invent facts. Give concrete, concise feedback.`;
const FINAL_EVAL_PROMPT = `You are a strict but fair technical interview coach. Return ONLY valid JSON: {"overall_score":0,"categories":{"technical_knowledge":0,"javascript":0,"html_css":0,"react":0,"apis_backend":0,"problem_solving":0,"system_thinking":0,"communication":0,"ui_ux":0,"project_knowledge":0,"confidence_clarity":0},"strong_areas":[],"weak_areas":[],"questions_missed":[],"technical_corrections":[],"recommended_topics":[],"suggested_practice_plan":""}. Score only evidence in the transcript; use 5 when a category was not meaningfully tested.`;
function parseJsonLoose(text) { const cleaned = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim(); try { return JSON.parse(cleaned); } catch { const a = cleaned.indexOf("{"); const b = cleaned.lastIndexOf("}"); if (a >= 0 && b > a) { try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {} } return null; } }

app.post("/evaluate", async (req, res) => {
  try {
    const { mode, question, answer, transcript } = req.body || {};
    let prompt, content;
    if (mode === "final") {
      if (!Array.isArray(transcript) || !transcript.length) return res.status(400).json({ error: "transcript is required" });
      prompt = FINAL_EVAL_PROMPT;
      content = transcript.slice(-80).map(m => `${m.role === "assistant" ? "Interviewer/AI Candidate" : "Candidate/Interviewer"}: ${m.content}`).join("\n\n");
    } else {
      if (!question || !answer) return res.status(400).json({ error: "question and answer are required" });
      prompt = ANSWER_EVAL_PROMPT;
      content = `Question: ${question}\n\nAnswer: ${answer}`;
    }
    const result = await getAIResponse([{ role: "system", content: prompt }, { role: "user", content }]);
    const parsed = parseJsonLoose(result?.content);
    if (!parsed) return res.status(502).json({ error: "Couldn't generate a valid report." });
    res.json(parsed);
  } catch (err) { console.error("EVALUATE ERROR", err); res.status(500).json({ error: "Evaluation failed." }); }
});

app.listen(PORT, () => console.log(`🚀 Codex Interview AI v2 running on ${PORT}`));
