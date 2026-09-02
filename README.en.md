# 🎬 Agnes Video Task Console

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)
![CI](https://img.shields.io/github/actions/workflow/status/AlanNiew/agnes-video-console/ci.yml?label=CI)
![Tests](https://img.shields.io/badge/tests-74%20unit%20%2B%2072%20e2e-brightgreen)

A local web console for the [Agnes AI video generation API](https://www.agnes-ai.com/en/docs/agnes-video-25-flash) with a
**creation workspace (6-step pipeline + fully automated final cut) + unified task center (video & image) + background polling + SQLite persistence**.

[中文 README](README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

Supports three models (async task API — `POST /v1/videos` to create, `GET /agnesapi` to poll):

| Model                   | Modes                                           | Parameters                                                                   | Price               | UI                                                  |
| ----------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ------------------- | --------------------------------------------------- |
| `agnes-video-2.5-flash` | text / keyframe / reference (image·audio·video) | `seconds` + `size` + `aspect_ratio`                                          | free (limited time) | ✅ default                                          |
| `agnes-video-2.5`       | text / keyframe / reference                     | `seconds` + `size` + `aspect_ratio`                                          | paid                | ✅ advanced                                         |
| `agnes-video-v2.0`      | text / image-to-video / keyframes animation     | `num_frames`(8n+1 ≤ 441) + `frame_rate` + `width/height` + `negative_prompt` | free (limited time) | ⛔ retired from UI (backend kept for compatibility) |

> Pricing and capabilities follow the [official Agnes AI docs](https://www.agnes-ai.com/en/docs/agnes-video-25-flash); both Flash and V2.0 are currently `$0 / second`.

## ✨ Features

- 🚀 Fully automated final cut (v2.0): tick "🚀 全自动成片" when creating a project and the whole pipeline runs itself — copywriting → storyboard → AI self-review → character sheet → per-shot videos → narration → render; each stage auto-retries, failed shots are re-taken once, TTS is skipped when unavailable, and a stall parks the run at a human-intervention point with one-click restart. Live progress timeline included
- 🎨 Unified image tasks (v2.0): "generate video / generate image" dual entry in the new-task dialog; image tasks share the task center list / detail / retry / download with video tasks (async worker + backoff retry + local archival), and standalone creation (no project) is supported
- 📋 Timeline task list (v2.0): every task in one list ordered by creation time (type/status badges + progress + failure reason + relative time) with real pagination (10/20/50 per page); the 4-column kanban remains as a switchable view
- 🎬 Final-cut style presets (v2.0): healing / high-energy / documentary / lecture / storybook presets apply a whole render recipe in one click; the advanced panel exposes 7 transition types, 3 subtitle styles, subtitle position and audio fine-tuning
- 🔍 AI self-review & QC (v2.0): one-click "AI 审查分镜" after storyboard generation (consistency / pacing / prompt quality → structured revisions you adopt per item); every render emits a QC report (duration deviation / loudness LUFS / narration coverage / subtitle lines)
- 🧭 Step-by-step guidance (v2.0): each workspace step ships a "what does this step do" beginner card + prev/next navigation with pre-checks + completion counter; project creation offers 8 style preset cards
- 🎵 Online BGM (v1.4): search an online music library (self-hosted NetEase-source API) from workspace step ⑥ → preview → one-click pick; at render time the BGM loops under the film with fade in/out and **auto-ducking under narration** (sidechaincompress); volume adjustable
- 🎞️ One-click final cut (v1.3): workspace step ⑥ assembles completed shot videos + per-shot narration into a full short film locally via ffmpeg (xfade transitions, narration aligned per shot, title/end cards, loudness normalization); output playable/downloadable from `data/artifacts/`
- 🚦 Server-side submit queue (v1.3): task creation is "enqueue" semantics; a background submitter throttles per `submit_interval_ms` and **auto-retries 429 rate limits with exponential backoff** — batch submits no longer leave dead records
- 💾 Local video archival (v1.3): completed videos auto-download to `data/artifacts` (`video_local_url` preferred for playback/download); startup sweep backfills history
- 🗑️ Superseded governance (v1.3): stale failed records of a shot with a newer successful task are auto-marked superseded
- 📝 Shot narration (v1.3): storyboard LLM emits per-shot `narration` copy (editable), one-click per-shot TTS bound via `shot_id`, aligned onto the final-cut timeline
- 🔀 Per-shot reference toggle (v1.3): pure-landscape/no-character shots can skip the character reference and submit in text mode
- 📡 Self-describing API (v1.3): `GET /api/openapi.json`; `/api/meta` carries upstream rate-limit hints
- 🎬 Creation workspace (6-step pipeline): one-line idea → AI copywriting (script / character / scene, editable, multi-version) → AI character sheet (pick a final) → video tasks (reference mode auto-references the character image with a `<Picture 1>` consistency injection) → narration → final cut
- 🎞️ Storyboard (M2): AI breaks the idea into multi-shot storyboards (per-shot title + prompt + duration; auto/3/5/8 shots), each shot editable / reorderable / deletable with versioned history; submit per shot or batch-submit unfinished shots with configurable throttling; tasks are traced per shot
- 🎬 Three models · per-model forms; model/aspect/duration lists served from `/api/meta` as the single source of truth
- 🔄 Background poller: configurable interval (default 2s), exponential backoff on 429/network errors, automatic timeout
- 🗄️ SQLite persistence via built-in `node:sqlite` (no native compilation), automatic migration, survives restarts
- 🔁 One-click retry for failed tasks (video & image; keeps history for audit)
- ▶️ Inline video preview & download for completed tasks; image tasks show a thumbnail wall
- 🔍 Full audit: request JSON, create response, last poll response, poll count
- ✍️ AI prompt optimizer in the new-task form with side-by-side before/after comparison — you decide whether to adopt; the workspace character description supports the same flow
- 🖼️ Multi-candidate images: generate 1–4 character/scene images at once and pick one as the seed image
- 🔐 API key stays server-side (SQLite), browser only sees a masked value; binds to `127.0.0.1` only
- 🧾 Built-in log panel
- ✅ End-to-end tests with a local fake Agnes API (no real key needed; 72 assertions, including 429 retry, local archival, async image tasks, the fully automated final-cut loop, BGM search/select, and a real-ffmpeg render when ffmpeg is available)

## 🚀 Quick Start

Requires **Node.js ≥ 22.13** (built-in `node:sqlite`; zero native dependencies).

```bash
git clone <repo-url> && cd agnes-video-console
npm install
npm start
```

Open **http://127.0.0.1:8273**, click ⚙ settings and enter your Agnes API Key.

> Override the port with `PORT=9000 npm start`.

## 📖 Usage

**Option A · Fully automated final cut (best for beginners, v2.0)**: tick "🚀 全自动成片" when creating a project → enter one idea + pick a style card → **do nothing else**: copywriting, storyboard, AI self-review revisions, character sheet, per-shot videos, per-shot narration and rendering all run in the background (auto-retry on failure, TTS skipped when unavailable). A progress timeline at the top shows every stage; a stall parks at a human-intervention point and can be restarted with one click.

**Option B · Creation workspace (step-by-step polishing)**: click "🎬 创作工作台" in the header → new project (one-line idea + style card + aspect/duration) → AI copywriting (editable, versioned) → "✨ 生成分镜" to break the idea into shots (use "🔍 AI 审查分镜" for structured revisions you adopt per item) → generate a character image and pick the final → submit shots one by one or "🚀 批量提交未完成镜头" (throttled by the "批量提交间隔" setting) → step ⑤ narration → step ⑥ pick a style preset (or tune the advanced panel) and render.

**Option C · Task center (single tasks)**:

1. **Settings**: API Key, Base URL (default `https://apihub.agnes-ai.com`), polling interval, task timeout.
2. **New task**: choose "🎬 generate video / 🖼️ generate image" → for video pick a model/mode and write the prompt (AI optimizer available); for image write the description and pick size/ratio/count → submit.
3. **Track in the list**: the timeline list shows every task newest-first (status filter + search + pagination); tasks flow through queued → in-progress → completed/failed. Switch back to the kanban view from the top-right toggle.
4. **On failure**: view the error in the detail panel, or retry with the same parameters (video & image alike).

**V2.0 tip** (backend API / historical tasks only; retired from the UI): duration = `num_frames / frame_rate` (e.g. 121/24 ≈ 5s); `num_frames` must be ≤ 441 and follow 8n+1 (81/121/241/441).

## 🏗️ Project Layout

```
agnes-video-console/
├── server.js            # Express assembly + static files + unified error middleware + startup orchestration (entry)
├── core/                # Zero/low-dep primitives: constants (models/whitelists/limits/presets) · config (single-source) · errors (ApiError/ah) · logger (ring buffer) · openapi (API self-description)
├── clients/             # Upstream API clients: agnes (video/chat/image) · fish-tts (Fish Audio TTS) · netmusic (BGM/music API)
├── services/            # Business layer: payloads (request validation) · task-queue (task enqueue) · prompts · subtitles (ASS/SRT pure fns) · voice-pool + pipeline (DI orchestration)
├── lib/                 # Local file/artifact support: artifacts (backup archive + works dir) · poster (social poster)
├── db.js                # SQLite layer (tasks / projects / texts / images / shots / tts / render_jobs + migration + transactions)
├── workers/             # Background workers (all guarded by the single-instance lock): submitter (throttle + 429 backoff) · poller (poll & archive) · image-worker · render (final-cut renderer) · auto (auto-pipeline state machine) · manager (start/stop & kick facade)
├── routes/              # Domain-split API routes (meta / settings / tasks / llm / images / tts / music / projects / render)
├── public/              # Frontend SPA (index.html / common.js shared utils / app.js task center / workspace.js creation workspace)
├── test/unit/           # Unit tests (jest: payload validation / LLM parsing / ASS subtitles / backoff math)
├── test/mock-e2e.js     # End-to-end smoke test with a local fake Agnes API
└── data/                # Runtime: agnes-console.db + artifacts backups (gitignored)
```

## 🧪 Testing

No real API key required:

```bash
npm test          # 74 unit tests (jest) + e2e smoke (fake Agnes API + real ffmpeg render)
```

CI runs lint → format check → unit tests → e2e on every push / PR.

## 🔒 Security

- Listens on `127.0.0.1` only — not exposed to LAN/public.
- API key is stored in local SQLite (`data/agnes-console.db`), used server-side only; the browser only ever sees a mask.
- Never commit `data/`, database files, or API keys (already in `.gitignore`).
- Report vulnerabilities via GitHub private vulnerability reporting — see [SECURITY.md](SECURITY.md).

## 🤝 Contributing

Issues and PRs are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) (Conventional Commits; changes must pass `npm run test:mock`).

## 📄 License

[MIT](LICENSE) © AlanNiew

## 🙏 Acknowledgements

- [Agnes AI](https://www.agnes-ai.com) — free multimodal AI API platform & official docs
- This project is not affiliated with Agnes AI; model capabilities and pricing follow the official docs
