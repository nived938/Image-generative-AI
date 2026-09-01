import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 10000);
const STAGE_NAME = process.env.STAGE_NAME || "gateway";
const NEXT_STAGE_URL = String(process.env.NEXT_STAGE_URL || "").replace(/\/$/, "");
const PIPELINE_SECRET = process.env.PIPELINE_SECRET || "";
const PROVIDER = process.env.IMAGE_PROVIDER || "none";
const PROVIDER_URL = String(process.env.IMAGE_PROVIDER_URL || "").replace(/\/$/, "");
const PROVIDER_KEY = process.env.IMAGE_PROVIDER_API_KEY || "";

function validSecret(req) {
  if (!PIPELINE_SECRET) return true;
  return req.get("x-pipeline-secret") === PIPELINE_SECRET;
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function normalizePrompt(prompt) {
  return String(prompt || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

function enhancePrompt(prompt) {
  return `${prompt}. High quality digital image, coherent composition, accurate anatomy where applicable, clean edges, natural lighting, detailed textures.`;
}

async function callNextStage(payload) {
  if (!NEXT_STAGE_URL) return payload;
  const response = await fetch(`${NEXT_STAGE_URL}/process`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(PIPELINE_SECRET ? { "x-pipeline-secret": PIPELINE_SECRET } : {})
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new Error(data?.message || `Next stage returned ${response.status}`);
  }
  return data;
}

async function generateWithProvider(job) {
  if (PROVIDER === "none") {
    return {
      status: "provider_required",
      message: "No image provider is configured. Configure IMAGE_PROVIDER, IMAGE_PROVIDER_URL and IMAGE_PROVIDER_API_KEY on the generation stage.",
      jobId: job.jobId
    };
  }

  if (PROVIDER === "custom") {
    if (!PROVIDER_URL) throw new Error("IMAGE_PROVIDER_URL is missing for custom provider.");
    const response = await fetch(`${PROVIDER_URL}/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(PROVIDER_KEY ? { authorization: `Bearer ${PROVIDER_KEY}` } : {})
      },
      body: JSON.stringify(job)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok) throw new Error(data?.message || `Image provider returned ${response.status}`);
    return { ...data, jobId: job.jobId };
  }

  throw new Error(`Unsupported IMAGE_PROVIDER: ${PROVIDER}`);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, stage: STAGE_NAME, provider: PROVIDER, nextStageConfigured: Boolean(NEXT_STAGE_URL) });
});

app.post("/process", async (req, res) => {
  try {
    if (!validSecret(req)) return res.status(401).json({ ok: false, message: "Invalid pipeline secret." });

    const input = req.body || {};
    const prompt = normalizePrompt(input.prompt);
    if (!prompt) return res.status(400).json({ ok: false, message: "Prompt is required." });

    const job = {
      jobId: input.jobId || crypto.randomUUID(),
      prompt,
      enhancedPrompt: STAGE_NAME === "prompt-enhancer" ? enhancePrompt(prompt) : input.enhancedPrompt || undefined,
      width: clampInt(input.width, 256, 2048, 1024),
      height: clampInt(input.height, 256, 2048, 1024),
      steps: clampInt(input.steps, 1, 8, 4),
      seed: Number.isInteger(input.seed) ? input.seed : crypto.randomInt(0, 2_147_483_647),
      stage: STAGE_NAME
    };

    if (STAGE_NAME === "gateway" || STAGE_NAME === "prompt-normalizer" || STAGE_NAME === "safety" || STAGE_NAME === "prompt-enhancer" || STAGE_NAME === "seed-options" || STAGE_NAME === "provider-selector") {
      if (STAGE_NAME === "safety" && prompt.length < 2) return res.status(400).json({ ok: false, message: "Prompt is too short." });
      if (STAGE_NAME === "provider-selector" && !input.provider) job.provider = PROVIDER;
      return res.json({ ok: true, ...(await callNextStage(job)) });
    }

    if (STAGE_NAME === "generation") {
      const result = await generateWithProvider(job);
      return res.json({ ok: true, ...result });
    }

    if (STAGE_NAME === "result-validator") {
      if (!input.imageUrl && !input.imageData && !input.image) return res.status(502).json({ ok: false, message: "Generation stage returned no image." });
      return res.json({ ok: true, validated: true, ...(await callNextStage(input)) });
    }

    if (STAGE_NAME === "asset-proxy") {
      return res.json({ ok: true, imageUrl: input.imageUrl, imageData: input.imageData, ...(await callNextStage(input)) });
    }

    if (STAGE_NAME === "convertflow-callback") {
      return res.json({ ok: true, status: "complete", imageUrl: input.imageUrl, imageData: input.imageData, jobId: input.jobId });
    }

    return res.json({ ok: true, ...(await callNextStage(job)) });
  } catch (error) {
    console.error(`[${STAGE_NAME}]`, error);
    return res.status(500).json({ ok: false, stage: STAGE_NAME, message: error?.message || "Stage failed." });
  }
});

app.listen(PORT, () => {
  console.log(`Image Generative AI stage '${STAGE_NAME}' listening on ${PORT}`);
});
