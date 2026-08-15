// ─────────────────────────────────────────────────────────
// AI PROVIDER ABSTRACTION
//
// Every provider supports multiple keys (comma-less: KEY, KEY_2, KEY_3, ...)
// so a single exhausted/expired key doesn't take the provider down.
// Rotating a key is always just an env-var change — never a code change.
//
// Fallback order: Groq -> Gemini -> OpenRouter -> Mistral -> Cerebras -> DeepSeek
// ─────────────────────────────────────────────────────────

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 15000);
const GROQ_RETRY_DELAY_MS = Number(process.env.GROQ_RETRY_DELAY_MS || 3000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Collects PREFIX, PREFIX_2, PREFIX_3, ... up to `max` — stops as soon as
// consecutive slots are missing isn't required, we just skip unset ones.
function envKeys(prefix, max = 10) {
  const keys = [];
  const first = process.env[prefix];
  if (first) keys.push(first);
  for (let i = 2; i <= max; i++) {
    const val = process.env[`${prefix}_${i}`];
    if (val) keys.push(val);
  }
  return keys;
}

function envList(name, fallback) {
  const raw = process.env[name] || fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────
// Providers that speak the OpenAI-compatible chat/completions shape
// (Groq, OpenRouter, Mistral, Cerebras, DeepSeek) share one caller.
// ─────────────────────────────────────────────────────────
const OPENAI_COMPATIBLE_PROVIDERS = [
  {
    name: "groq",
    keys: envKeys("GROQ_API_KEY"),
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    models: envList("GROQ_MODELS", "llama-3.1-8b-instant"),
  },
  {
    name: "openrouter",
    keys: envKeys("OPENROUTER_API_KEY"),
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    models: envList(
      "OPENROUTER_MODELS",
      "meta-llama/llama-3.3-70b-instruct:free,meta-llama/llama-4-scout:free"
    ),
    extraHeaders: {
      "HTTP-Referer": process.env.APP_URL || "https://codex-interview-ai.app",
      "X-Title": "Codex Interview AI",
    },
  },
  {
    name: "mistral",
    keys: envKeys("MISTRAL_API_KEY"),
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    models: envList("MISTRAL_MODELS", "mistral-small-latest"),
  },
  {
    name: "cerebras",
    keys: envKeys("CEREBRAS_API_KEY"),
    endpoint: "https://api.cerebras.ai/v1/chat/completions",
    models: envList("CEREBRAS_MODELS", "gpt-oss-120b"),
  },
  {
    name: "deepseek",
    keys: envKeys("DEEPSEEK_API_KEY"),
    endpoint: "https://api.deepseek.com/chat/completions",
    models: envList("DEEPSEEK_MODELS", "deepseek-chat"),
  },
];

// Tries every key x model combo for one provider.
// 429/503 -> try next combo (rate limit / overload, worth rotating keys).
// 413 -> stop entirely for this provider (payload issue, not key issue).
// other errors -> log and move to next combo anyway (cheap, and a bad key
// shouldn't take down every other key on the same provider).
async function callOpenAICompatible(provider, messages) {
  for (const key of provider.keys) {
    for (const model of provider.models) {
      try {
        const res = await fetchWithTimeout(provider.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            ...(provider.extraHeaders || {}),
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.7,
            max_tokens: 4096,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const content = data?.choices?.[0]?.message?.content;
          if (content) return { content, provider: provider.name, model };
        }

        if (res.status === 429 || res.status === 503) continue;

        if (res.status === 413) {
          console.log(`${provider.name}/${model} payload too large — skipping provider`);
          return null;
        }

        console.log(`${provider.name}/${model} failed (${res.status})`);
      } catch (err) {
        console.log(`${provider.name}/${model} threw: ${err.message}`);
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// Gemini has a different request/response shape, so it gets its own caller.
// ─────────────────────────────────────────────────────────
async function callGemini(messages) {
  const keys = envKeys("GEMINI_API_KEY");
  if (!keys.length) return null;

  const models = envList("GEMINI_MODELS", "gemini-2.0-flash,gemini-2.5-flash");
  const systemMsg = messages.find((m) => m.role === "system");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const body = {
    contents: turns.length ? turns : [{ role: "user", parts: [{ text: "Hello" }] }],
  };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };

  for (const key of keys) {
    for (const model of models) {
      try {
        const res = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );

        if (res.ok) {
          const data = await res.json();
          const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (content) return { content, provider: "gemini", model };
        }

        if (res.status !== 429 && res.status !== 503) {
          console.log(`gemini/${model} failed (${res.status})`);
        }
      } catch (err) {
        console.log(`gemini/${model} threw: ${err.message}`);
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// Orchestrator — this is the only export the rest of the app needs.
// ─────────────────────────────────────────────────────────
export async function getAIResponse(messages) {
  const groq = OPENAI_COMPATIBLE_PROVIDERS.find((p) => p.name === "groq");

  if (groq.keys.length) {
    let result = await callOpenAICompatible(groq, messages);
    if (result) return result;

    // All Groq keys were rate-limited/unavailable on the first pass —
    // give it one short backoff-and-retry before moving on to fallbacks.
    console.log(`All Groq keys failed — retrying once after ${GROQ_RETRY_DELAY_MS}ms`);
    await sleep(GROQ_RETRY_DELAY_MS);
    result = await callOpenAICompatible(groq, messages);
    if (result) return result;
  }

  const geminiResult = await callGemini(messages);
  if (geminiResult) return geminiResult;

  for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
    if (provider.name === "groq" || !provider.keys.length) continue;
    const result = await callOpenAICompatible(provider, messages);
    if (result) return result;
  }

  return null;
}

// ─────────────────────────────────────────────────────────
// Transcription — Groq Whisper Large V3 Turbo.
// Keeps the same multi-key rotation pattern as the chat providers.
// ─────────────────────────────────────────────────────────
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS || 20000);

export async function transcribeAudio(buffer, filename, mimetype) {
  const keys = envKeys("GROQ_API_KEY");
  if (!keys.length) return null;

  const model = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo";

  for (const key of keys) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: mimetype || "audio/webm" }), filename || "audio.webm");
      form.append("model", model);
      form.append("response_format", "verbose_json");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);

      let res;
      try {
        res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        const data = await res.json();
        return {
          text: (data.text || "").trim(),
          duration: data.duration ?? null,
          language: data.language ?? null,
        };
      }

      if (res.status === 429 || res.status === 503) continue;
      console.log(`groq whisper failed (${res.status})`);
    } catch (err) {
      console.log(`groq whisper threw: ${err.message}`);
    }
  }
  return null;
}

export function providerStatus() {
  const status = {};
  for (const p of OPENAI_COMPATIBLE_PROVIDERS) {
    status[p.name] = { keys: p.keys.length, models: p.models };
  }
  status.gemini = { keys: envKeys("GEMINI_API_KEY").length, models: envList("GEMINI_MODELS", "gemini-2.0-flash,gemini-2.5-flash") };
  return status;
}


// ─────────────────────────────────────────────────────────
// OPTIONAL STREAMING CHAT
//
// This is additive: the existing getAIResponse() path above is untouched and
// remains the compatibility/fallback path. The frontend can use /chat/stream
// when the browser supports streaming, and fall back to /chat automatically.
// ─────────────────────────────────────────────────────────

async function fetchStreaming(url, options) {
  return fetch(url, options);
}

async function* parseOpenAIStream(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const event of events) {
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch (_) {}
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function streamOpenAICompatible(provider, messages) {
  for (const key of provider.keys) {
    for (const model of provider.models) {
      try {
        const res = await fetchStreaming(provider.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            ...(provider.extraHeaders || {}),
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.7,
            max_tokens: 4096,
            stream: true,
          }),
        });

        if (!res.ok) {
          if (res.status !== 429 && res.status !== 503) {
            console.log(`${provider.name}/${model} streaming failed (${res.status})`);
          }
          continue;
        }

        return { stream: parseOpenAIStream(res), provider: provider.name, model };
      } catch (err) {
        console.log(`${provider.name}/${model} streaming threw: ${err.message}`);
      }
    }
  }
  return null;
}

export async function streamAIResponse(messages) {
  const groq = OPENAI_COMPATIBLE_PROVIDERS.find((p) => p.name === "groq");
  if (groq?.keys.length) {
    const result = await streamOpenAICompatible(groq, messages);
    if (result) return result;
  }

  // Streaming is an optimization, not a reliability requirement. If Groq
  // streaming is unavailable, the existing full-response orchestrator remains
  // the authoritative fallback so no existing provider behavior is lost.
  const fallback = await getAIResponse(messages);
  if (!fallback?.content) return null;

  async function* oneChunk() {
    yield fallback.content;
  }
  return { stream: oneChunk(), provider: fallback.provider, model: fallback.model };
}
