# ADR-0003: Model routing on Nebius Token Factory

## Status
Accepted (pending team review). Refines rule #1 in [AGENTS.md](../../AGENTS.md); supersedes the embeddings row of [ADR-0001](./0001-stack-and-versions.md).

## Date
2026-10-05

## Context
The specs assumed five NVIDIA models on Token Factory: Nemotron 3 Nano, Super, Ultra, **Nano Omni** (images) and an **NVIDIA embedding model**. The live catalogue (`GET /v1/models`, checked 2026-10-05) has only four Nemotron models, all text-only, and no NVIDIA embedding model.

Hackathon rules: an entry must make **runtime calls to Token Factory** and use **at least one NVIDIA open model**. Other models aren't forbidden. Two of the four equally weighted judging criteria score how well Token Factory and Nemotron are used, and the Best Apps & Agents track asks for Ultra for deep reasoning and Nano or Super for fast calls.

Budget: about $25–50 of Token Factory credit per account, with the demo key needing to last until judging ends (Dec 15, 2026).

## Decision
**All model calls go through Token Factory** (one OpenAI-compatible client, one key, one log and budget). **Nemotron does all reasoning and text.** A non-NVIDIA Token Factory model is used only where no Nemotron model can do the job, and the README says so. **No local models.**

| Part | Model ID | $ per 1M tokens (in / out) | Fallback |
|---|---|---|---|
| Orchestrator (tool calling) | `nvidia/nemotron-3-super-120b-a12b` | 0.30 / 0.90 | `nvidia/Nemotron-3_5-Lightning`, then the fixed Python pipeline |
| News Scout (classification, reasoning off) | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 0.06 / 0.24 | Lightning |
| Auditor (deep reasoning, capped) | `nvidia/Nemotron-3-Ultra-550b-a55b` | 1.00 / 3.00 | Super, report flagged `degraded_model` |
| Copilot (streamed chat, tools) | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 0.06 / 0.24 | Lightning |
| Field Evidence: perception only | `openbmb/MiniCPM-V-4_5` (vision, JSON mode) | 0.66 / 1.11 | Code checks only (EXIF GPS/date) |
| Copilot retrieval (embeddings) | `Qwen/Qwen3-Embedding-8B` with `dimensions=1024` | 0.01 / – | – |

Field Evidence splits **seeing from judging**. MiniCPM-V describes the photo, code checks that the GPS and date fall inside the polygon and recent window, and the Nemotron Ultra Auditor decides what the evidence means for the rating.

Estimated cost: ≈ $0.035 per full rating, ≈ $0.0002 per photo, ≈ $0.0003 per Copilot answer. Repeat Time Machine ratings are cached per `(asset, data_version, events)`, so judging doesn't re-spend.

## Evidence (2026-10-05, Token Factory, `us-central1`)
- `/v1/models` lists 25 models; the Nemotron ones are Nano 30B, Super 120B, Ultra 550B and 3.5 Lightning, all `text->text`, all with `tools` and `reasoning`.
- `Qwen/Qwen3-Embedding-8B` returned 4,096 numbers by default and **exactly 1,024 with `dimensions=1024`**, matching `doc_chunks.embedding vector(1024)`.
- Vision test (one PNG, JSON-only prompt, `max_tokens=300`):
  - `openbmb/MiniCPM-V-4_5` returned **valid JSON in 1.0 s** and found the water, the vegetation and a dumped object;
  - `zai-org/GLM-5.3-Flash` spent all tokens on reasoning and returned **empty content after 15.5 s**.

## T02 spike results (2026-10-06)
`scripts/spikes/token_factory.py` reproduces everything below (run from `backend/`: `uv run --with openai python ../scripts/spikes/token_factory.py`).
- **Setup:** 120 calls in total: 4 Nemotron models × 3 runs × reasoning on/off. Run twice (the second time with stricter checks); the numbers below are from the second run.
- **What it tests:**
  - structured output against our real `NewsScoutItem` contract (a fire article must come back as `fire` with `direction -1`);
  - a two-step Orchestrator tool loop (`earth_obs`, then `valuation` with the returned `metrics_id`). Every argument must match, and step 2 only runs if step 1 was correct;
  - whether reasoning really switched off (no reasoning text and no reasoning tokens).
- **Cost:** $0.039 per run.

**Correct results, out of 3 each** (p50 latency in brackets):
| Model | `json_schema`, reasoning off | `json_schema`, reasoning on | `json_object`, reasoning off | Tool loop (2 steps), reasoning off | $ per call, JSON off / on |
|---|---|---|---|---|---|
| Nano 30B | 3/3 (1.8 s) | 3/3 (5.7 s) | 3/3 | 6/6 (1.2 s each) | 0.00006 / 0.00015 |
| 3.5 Lightning | 3/3 (1.0 s) | **1/3** (2/3 in the first run; ~8.7 s, ~1,550 tokens out) | **0/3** (missing fields) | 6/6 (0.5 s each) | 0.00006 / 0.00040 |
| Super 120B | 3/3 (0.9 s) | 3/3 (2.6 s) | 3/3 | 6/6 (0.9 s each) | 0.00024 / 0.00053 |
| Ultra 550B | 3/3 (0.8 s) | 3/3 (1.5 s) | 3/3 | 6/6 (0.7 s each) | 0.00086 / 0.00177 |

**Findings**
1. **Use `response_format={"type": "json_schema", "json_schema": {"name", "schema", "strict": true}}` (the OpenAI shape) and also put the schema in the prompt.**
   - It was valid and correct on every model with reasoning off.
   - The raw-schema shape shown in the Token Factory docs' Python and cURL examples **fails on every model with HTTP 422** (`json_schema.name` is required). That's a docs bug to report in our feedback.
   - `json_object` with the schema only in the prompt is weaker: Lightning dropped required fields.
2. **Define every label's meaning.** With an undocumented `direction` field, Nano (reasoning off) labelled a fire `+1` in the first smoke run. Once the prompt defined `-1`, `0` and `1`, every model was correct. T13 should add `Field(description=…)` to `NewsScoutItem`.
3. **Reasoning toggle:** `extra_body={"chat_template_kwargs": {"enable_thinking": False}}` was honoured in **60/60** reasoning-off calls across all four models: no reasoning text and no reasoning tokens (source: the NVIDIA Nemotron 3 Nano model card).
   - Reasoning is **on by default.**
   - Turning it off cut Nano's latency about 3× and its cost about 2.5× with no loss of correctness on these tasks.
   - The reasoning text comes back in a separate `message.reasoning` field. `content` stays clean, so T09 can log the reasoning for the Agent Trace drawer.
4. **Tool calling** worked on every model (24/24 two-step loops, every argument correct), with reasoning on or off.
   - **Lightning** was the fastest (~0.5 s per step) at Nano's price. It's a strong, cheap candidate for the Orchestrator.
   - Its structured JSON is less reliable with reasoning on or with `json_object`. Keep it as the fallback for `MODEL_FAST`, not the default.
5. **Ultra was faster than Nano** on the shared endpoints (0.8 s vs 1.8 s for the same JSON task). Latency depends on load as much as on size, so the eval harness (T47) should measure p50 at demo time.

**Interim routing to build against** (T09, T13): reasoning **off** for News Scout, Copilot and the Orchestrator; **on** for the Auditor (Ultra), where it costs under $0.002 per call. `MODEL_FAST` stays Nano; Super stays the Orchestrator. These results come from N=3 runs of one news item and one toy tool loop, so **the T47 evals (≥30 labelled news items, full rating loop) are the decision point**, including Super vs Lightning for the Orchestrator.

**Update (T26, 2026-10-07):** the Auditor's JSON call runs with thinking **off**. On the full audit task (about 2,500 prompt tokens), Ultra with thinking on spent its whole 3,000-token cap reasoning and returned truncated JSON on both attempts; with thinking off it returned a valid audit in about 2 s for under $0.005 per call. Details in [dev-spec §7.7](../specs/dev-spec.md).

## Consequences
- The backend stays a small CPU-only container with no GPU and no model weights, so every hosting option ranked in [dev-spec §21](../specs/dev-spec.md) works: Nebius Serverless, Azure Container Apps (team-approved credits), or Hugging Face Spaces / Render.
- Model IDs live in `.env` (`MODEL_*`), so swapping a model is a config change. `make check-keys` warns if a configured ID isn't served.
- The Agent Trace drawer and the README must show which model handled each step, including the two non-NVIDIA ones.
- Photo evidence (T40) is now cheap and feasible, but stays "only if ahead".

## Alternatives considered
- **Nemotron-only, no vision, local `bge-small` embeddings.** Rejected:
  - it loses photo evidence;
  - `bge-small` returns 384 numbers, not 1,024;
  - a local model adds 0.1–2.3 GB of weights and RAM, which rules out free hosts with 512 MB.
- **Local `bge-m3` embeddings (1,024).** Rejected: about 2.3 GB of weights, slow cold starts, and the free-host limits above.
- **Nemotron Nano Omni from NVIDIA's own API, or self-hosted on Nebius GPUs.** Rejected: a second provider and key, or GPU cost not covered by credits.
- **Another provider (OpenAI, Azure and so on).** Rejected: adds nothing to the judging criteria.
