import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "8mb" }));

const PORT = Number(process.env.PORT || 10000);
const STAGE_NAME = process.env.STAGE_NAME || "gateway";
const NEXT_STAGE_URL = String(process.env.NEXT_STAGE_URL || "").replace(/\/$/, "");
const PIPELINE_SECRET = process.env.PIPELINE_SECRET || "";
const pollinationsKeys = String(process.env.POLLINATIONS_API_KEYS || process.env.POLLINATIONS_API_KEY || "")
  .split(",")
  .map(key => key.trim())
  .filter(Boolean);
const POLLINATIONS_IMAGE_MODEL = process.env.POLLINATIONS_IMAGE_MODEL || "flux";

function validSecret(req) {
  return !PIPELINE_SECRET || req.get("x-pipeline-secret") === PIPELINE_SECRET;
}
function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function normalizePrompt(prompt) {
  return String(prompt || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
}
function enhancePrompt(prompt) {
  return `${prompt}. High quality digital image, coherent composition, clean edges, natural lighting, detailed textures.`;
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function retryDelay(response) {
  const header = Number.parseInt(response.headers.get("retry-after") || "", 10);
  if (Number.isFinite(header) && header >= 0) return Math.min(header * 1000, 15000);
  return 1500;
}
async function next(payload) {
  if (!NEXT_STAGE_URL) return payload;
  const r = await fetch(`${NEXT_STAGE_URL}/process`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(PIPELINE_SECRET ? { "x-pipeline-secret": PIPELINE_SECRET } : {}) },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const error = new Error(data?.message || `Next stage returned ${r.status}`);
    error.status = r.status;
    error.retryAfter = r.headers.get("retry-after") || "";
    throw error;
  }
  return data;
}
async function requestPollinations(url, key) {
  return fetch(url, { headers: { Authorization: `Bearer ${key}` } });
}
async function generateImage(job) {
  if (!pollinationsKeys.length) throw new Error("POLLINATIONS_API_KEY is missing on the generation stage.");
  const prompt = encodeURIComponent(job.enhancedPrompt || job.prompt);
  const url = `https://gen.pollinations.ai/image/${prompt}?model=${encodeURIComponent(POLLINATIONS_IMAGE_MODEL)}&width=${job.width}&height=${job.height}&seed=${job.seed}&nologo=true&enhance=true`;
  let last429 = null;

  for (let index = 0; index < pollinationsKeys.length; index += 1) {
    const key = pollinationsKeys[index];
    let response = await requestPollinations(url, key);

    if (response.status === 429) {
      const delay = retryDelay(response);
      last429 = response;
      if (index < pollinationsKeys.length - 1) continue;
      if (delay > 0) await sleep(delay);
      response = await requestPollinations(url, key);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const error = new Error(`Pollinations returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
      error.status = response.status;
      error.retryAfter = response.headers.get("retry-after") || "";
      throw error;
    }

    const mime = response.headers.get("content-type") || "image/jpeg";
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("Pollinations returned an empty image.");
    return { imageData: `data:${mime};base64,${bytes.toString("base64")}`, mime };
  }

  if (last429) {
    const error = new Error("Pollinations is rate-limiting the configured image-generation key(s). Use a server-side sk_ key with available Pollen, or configure multiple keys in POLLINATIONS_API_KEYS.");
    error.status = 429;
    error.retryAfter = last429.headers.get("retry-after") || "";
    throw error;
  }
  throw new Error("No image provider key is available.");
}

app.get("/health", (_req, res) => res.json({ ok: true, stage: STAGE_NAME, provider: STAGE_NAME === "generation" ? "pollinations" : "pipeline", nextStageConfigured: Boolean(NEXT_STAGE_URL), providerKeysConfigured: pollinationsKeys.length }));

app.post("/generate", async (req, res) => {
  try {
    if (STAGE_NAME !== "gateway") return res.status(404).json({ ok: false, message: "Generate endpoint is available on the gateway stage only." });
    if (!validSecret(req)) return res.status(401).json({ ok: false, message: "Invalid pipeline secret." });
    const input = req.body || {};
    const prompt = normalizePrompt(input.prompt);
    if (!prompt) return res.status(400).json({ ok: false, message: "Prompt is required." });
    const job = { ...input, jobId: input.jobId || crypto.randomUUID(), prompt, width: clampInt(input.width, 256, 1024, 1024), height: clampInt(input.height, 256, 1024, 1024), steps: clampInt(input.steps, 1, 8, 4), seed: Number.isInteger(input.seed) ? input.seed : crypto.randomInt(0, 2147483647) };
    return res.json(await next(job));
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (error?.retryAfter) res.set("Retry-After", String(error.retryAfter));
    return res.status(status).json({ ok: false, stage: STAGE_NAME, message: error?.message || "Generation failed." });
  }
});

app.post("/process", async (req, res) => {
  try {
    if (!validSecret(req)) return res.status(401).json({ ok: false, message: "Invalid pipeline secret." });
    const input = req.body || {};
    const prompt = normalizePrompt(input.prompt);
    if (!prompt) return res.status(400).json({ ok: false, message: "Prompt is required." });
    const job = {
      ...input,
      jobId: input.jobId || crypto.randomUUID(),
      prompt,
      enhancedPrompt: input.enhancedPrompt || prompt,
      width: clampInt(input.width, 256, 1024, 1024),
      height: clampInt(input.height, 256, 1024, 1024),
      steps: clampInt(input.steps, 1, 8, 4),
      seed: Number.isInteger(input.seed) ? input.seed : crypto.randomInt(0, 2147483647),
      stage: STAGE_NAME
    };
    if (STAGE_NAME === "gateway") return res.json({ ok: true, ...(await next(job)) });
    if (STAGE_NAME === "prompt-normalizer") { job.prompt = normalizePrompt(job.prompt); job.enhancedPrompt = job.prompt; return res.json({ ok: true, ...(await next(job)) }); }
    if (STAGE_NAME === "safety") { if (job.prompt.length < 2) return res.status(400).json({ ok: false, message: "Prompt is too short." }); return res.json({ ok: true, ...(await next(job)) }); }
    if (STAGE_NAME === "prompt-enhancer") { job.enhancedPrompt = enhancePrompt(job.prompt); return res.json({ ok: true, ...(await next(job)) }); }
    if (STAGE_NAME === "seed-options") { job.width = clampInt(job.width, 256, 1024, 1024); job.height = clampInt(job.height, 256, 1024, 1024); return res.json({ ok: true, ...(await next(job)) }); }
    if (STAGE_NAME === "provider-selector") { job.provider = "pollinations"; return res.json({ ok: true, ...(await next(job)) }); }
    if (STAGE_NAME === "generation") {
      const image = await generateImage(job);
      return res.json({ ok: true, ...(await next({ ...job, ...image, stage: STAGE_NAME })) });
    }
    if (STAGE_NAME === "result-validator") {
      if (!job.imageData) return res.status(502).json({ ok: false, message: "Generation stage returned no image." });
      return res.json({ ok: true, ...(await next({ ...job, validated: true, stage: STAGE_NAME })) });
    }
    if (STAGE_NAME === "asset-proxy") return res.json({ ok: true, ...(await next({ ...job, stage: STAGE_NAME })) });
    if (STAGE_NAME === "convertflow-callback") return res.json({ ok: true, status: "complete", imageData: job.imageData, jobId: job.jobId, prompt: job.prompt });
    return res.json({ ok: true, ...(await next(job)) });
  } catch (error) {
    console.error(`[${STAGE_NAME}]`, error);
    const status = Number(error?.status) || 500;
    if (error?.retryAfter) res.set("Retry-After", String(error.retryAfter));
    return res.status(status).json({ ok: false, stage: STAGE_NAME, message: error?.message || "Stage failed." });
  }
});

app.listen(PORT, () => console.log(`Image Generative AI stage '${STAGE_NAME}' listening on ${PORT}`));
