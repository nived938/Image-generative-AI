import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "8mb" }));

const PORT = Number(process.env.PORT || 10000);
const STAGE_NAME = process.env.STAGE_NAME || "gateway";
const NEXT_STAGE_URL = String(process.env.NEXT_STAGE_URL || "").replace(/\/$/, "");
const PIPELINE_SECRET = process.env.PIPELINE_SECRET || "";
const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY || "";
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
async function next(payload) {
  if (!NEXT_STAGE_URL) return payload;
  const r = await fetch(`${NEXT_STAGE_URL}/process`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(PIPELINE_SECRET ? { "x-pipeline-secret": PIPELINE_SECRET } : {}) },
    body: JSON.stringify(payload)
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(data?.message || `Next stage returned ${r.status}`);
  return data;
}
async function generateImage(job) {
  if (!POLLINATIONS_API_KEY) throw new Error("POLLINATIONS_API_KEY is missing on the generation stage.");
  const prompt = encodeURIComponent(job.enhancedPrompt || job.prompt);
  const url = `https://gen.pollinations.ai/image/${prompt}?model=${encodeURIComponent(POLLINATIONS_IMAGE_MODEL)}&width=${job.width}&height=${job.height}&seed=${job.seed}&nologo=true&enhance=true`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${POLLINATIONS_API_KEY}` } });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`Pollinations returned ${r.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
  }
  const mime = r.headers.get("content-type") || "image/jpeg";
  const bytes = Buffer.from(await r.arrayBuffer());
  if (!bytes.length) throw new Error("Pollinations returned an empty image.");
  return { imageData: `data:${mime};base64,${bytes.toString("base64")}`, mime };
}

app.get("/health", (_req, res) => res.json({ ok: true, stage: STAGE_NAME, provider: STAGE_NAME === "generation" ? "pollinations" : "pipeline", nextStageConfigured: Boolean(NEXT_STAGE_URL) }));

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
    return res.status(500).json({ ok: false, stage: STAGE_NAME, message: error?.message || "Generation failed." });
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
    return res.status(500).json({ ok: false, stage: STAGE_NAME, message: error?.message || "Stage failed." });
  }
});

app.listen(PORT, () => console.log(`Image Generative AI stage '${STAGE_NAME}' listening on ${PORT}`));
