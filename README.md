# ConvertFlow Image Generative AI

A lightweight staged image-generation service designed to run as multiple small Render web services.

## Important architecture note

The stages are request/pipeline stages, not shared-memory model shards. Ten 512 MB Render services do **not** make a single 5 GB RAM process. Each stage stays lightweight and passes JSON/job data to the next stage.

The reference implementation uses a provider adapter for the actual image model. This keeps the Render workers small and lets the generator provider be swapped without changing ConvertFlow.

## Pipeline

1. Gateway, validates requests and creates a job.
2. Prompt normalizer, cleans and validates prompt metadata.
3. Safety, rejects empty or malformed requests.
4. Prompt enhancer, creates a structured generation prompt.
5. Seed/options, creates deterministic generation settings.
6. Provider selector, selects the configured image provider.
7. Generation request, calls the configured image provider.
8. Result validator, verifies an image response.
9. Asset proxy, stores/returns a short-lived image result.
10. ConvertFlow callback, returns the finished image to ConvertFlow.

Stages 1-6 and 8-10 are deliberately tiny. Stage 7 is an adapter and should call a hosted model provider instead of loading a multi-GB diffusion model into a free Render instance.

## Environment

```env
PORT=10000
STAGE_NAME=gateway
NEXT_STAGE_URL=
PIPELINE_SECRET=change-me
IMAGE_PROVIDER=none
IMAGE_PROVIDER_URL=
IMAGE_PROVIDER_API_KEY=
CONVERTFLOW_CALLBACK_SECRET=change-me
```

Each Render service gets its own `STAGE_NAME`, `NEXT_STAGE_URL`, and the same pipeline secret.

## Run locally

```bash
npm install
npm start
```

The stage API exposes:

- `GET /health`
- `POST /process`

The gateway accepts a JSON body:

```json
{
  "prompt": "a cinematic neon city at night",
  "width": 1024,
  "height": 1024,
  "steps": 4,
  "seed": 12345
}
```

## ConvertFlow integration

ConvertFlow should call the gateway's `/generate` endpoint. The gateway forwards the job through the configured stages and returns the final image URL/base64 payload.

For a true no-billing setup, configure a free hosted image provider or browser-side provider in the provider adapter. Do not put provider secrets in the ConvertFlow frontend.
