# 🎬 Agnes Video Task Console

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)
![CI](https://img.shields.io/github/actions/workflow/status/AlanNiew/agnes-video-console/ci.yml?label=CI)
![Tests](https://img.shields.io/badge/tests-40%20passed-brightgreen)

A local web console for the [Agnes AI video generation API](https://www.agnes-ai.com/en/docs/agnes-video-25-flash) with a
**creation workspace (4-step pipeline) + task-queue board + background polling + SQLite persistence**.

[中文 README](README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

Supports three models (async task API — `POST /v1/videos` to create, `GET /agnesapi` to poll):

| Model | Modes | Parameters | Price | UI |
| --- | --- | --- | --- | --- |
| `agnes-video-2.5-flash` | text / keyframe / reference (image·audio·video) | `seconds` + `size` + `aspect_ratio` | free (limited time) | ✅ default |
| `agnes-video-2.5` | text / keyframe / reference | `seconds` + `size` + `aspect_ratio` | paid | ✅ advanced |
| `agnes-video-v2.0` | text / image-to-video / keyframes animation | `num_frames`(8n+1 ≤ 441) + `frame_rate` + `width/height` + `negative_prompt` | free (limited time) | ⛔ retired from UI (backend kept for compatibility) |

> Pricing and capabilities follow the [official Agnes AI docs](https://www.agnes-ai.com/en/docs/agnes-video-25-flash); both Flash and V2.0 are currently `$0 / second`.

## ✨ Features

- 🎬 Creation workspace (4-step pipeline): one-line idea → AI copywriting (script / video prompt / character / scene, editable, multi-version) → AI character sheet (pick a final) → one-click video task (reference mode auto-references the character image with a `<Picture 1>` consistency injection)
- 🎬 Three models · per-model forms; model/aspect/duration lists served from `/api/meta` as the single source of truth
- 📋 Kanban task board: queued / in-progress / completed / failed, live progress, search & filters
- 🔄 Background poller: configurable interval (default 2s), exponential backoff on 429/network errors, automatic timeout
- 🗄️ SQLite persistence via built-in `node:sqlite` (no native compilation), automatic migration, survives restarts
- 🔁 One-click retry for failed tasks (keeps history for audit)
- ▶️ Inline video preview & download for completed tasks
- 🔍 Full audit: request JSON, create response, last poll response, poll count
- ✍️ AI prompt optimizer in the new-task form (LLM rewrites your raw description)
- 🔐 API key stays server-side (SQLite), browser only sees a masked value; binds to `127.0.0.1` only
- 🧾 Built-in log panel
- ✅ End-to-end tests with a local fake Agnes API (no real key needed; 40 assertions)

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

**Option A · Creation workspace (recommended)**: click "🎬 创作工作台" in the header → new project (one-line idea + aspect/duration) → AI generates four copy types (editable, versioned) → generate a character image and pick the final → "🚀 提交视频任务" assembles the reference-mode payload automatically (final character image + `<Picture 1>` consistency injection).

**Option B · Task center (single tasks)**:

1. **Settings**: API Key, Base URL (default `https://apihub.agnes-ai.com`), polling interval, task timeout.
2. **New task**: choose model → the form adapts automatically → write the prompt → add media URLs per mode (must be publicly accessible `http(s)`) → submit.
3. **Track on the board**: tasks flow through queued → in-progress → completed/failed. Play or download when done.
4. **On failure**: view the error in the detail panel, or retry with the same parameters (creates a new task).

**V2.0 tip** (backend API / historical tasks only; retired from the UI): duration = `num_frames / frame_rate` (e.g. 121/24 ≈ 5s); `num_frames` must be ≤ 441 and follow 8n+1 (81/121/241/441).

## 🏗️ Project Layout

```
agnes-video-console/
├── server.js            # Express API + validation (per model family) + pipeline endpoints + static files
├── db.js                # SQLite layer (tasks / projects / texts / images / settings + migration + transactions)
├── agnes.js             # Agnes API client (video create/query / chat / images)
├── poller.js            # Background poller (backoff / timeout / stuck-task cleanup)
├── logger.js            # In-memory ring-buffer log
├── public/              # Frontend SPA (index.html / style.css / app.js task center / workspace.js creation workspace)
├── test/mock-e2e.js     # End-to-end smoke test with a local fake Agnes API
└── data/                # Runtime: agnes-console.db + artifacts backups (gitignored)
```

## 🧪 Testing

No real API key required — a local fake Agnes API verifies the whole create → poll → complete loop plus per-model validation:

```bash
npm run test:mock
```

Expected output: `== 全部通过 ✔ ==` (currently **40 assertions**, covering the full task loop, the creation pipeline, input validation and security constraints). CI runs it on every push / PR.

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