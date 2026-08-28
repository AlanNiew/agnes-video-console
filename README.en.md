# 🎬 Agnes Video Task Console

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)
![Tests](https://img.shields.io/badge/tests-18%20passed-brightgreen)

A local web console for the [Agnes AI video generation API](https://www.agnes-ai.com/en/docs/agnes-video-25-flash) with a
**task-queue board + background polling + SQLite persistence**.

Supports three models (async task API — `POST /v1/videos` to create, `GET /agnesapi` to poll):

| Model | Modes | Parameters | Price |
| --- | --- | --- | --- |
| `agnes-video-2.5-flash` | text / keyframe / reference (image·audio·video) | `seconds` + `size` + `aspect_ratio` | free (limited time) |
| `agnes-video-v2.0` | text / image-to-video / keyframes animation | `num_frames`(8n+1 ≤ 441) + `frame_rate` + `width/height` + `negative_prompt` | free (limited time) |
| `agnes-video-2.5` | text / keyframe / reference | `seconds` + `size` + `aspect_ratio` | paid |

> Pricing and capabilities follow the [official Agnes AI docs](https://www.agnes-ai.com/en/docs/agnes-video-25-flash); both Flash and V2.0 are currently `$0 / second`.

## ✨ Features

- 🎬 Three models · per-model forms (2.5 family vs V2.0 parameter styles)
- 📋 Kanban task board: queued / in-progress / completed / failed, live progress, search & filters
- 🔄 Background poller: configurable interval (default 2s), exponential backoff on 429/network errors, automatic timeout
- 🗄️ SQLite persistence via built-in `node:sqlite` (no native compilation), automatic migration, survives restarts
- 🔁 One-click retry for failed tasks (keeps history for audit)
- ▶️ Inline video preview & download for completed tasks
- 🔍 Full audit: request JSON, create response, last poll response, poll count
- 🔐 API key stays server-side (SQLite), browser only sees a masked value; binds to `127.0.0.1` only
- 🧾 Built-in log panel
- ✅ End-to-end tests with a local fake Agnes API (no real key needed)

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

1. **Settings**: API Key, Base URL (default `https://apihub.agnes-ai.com`), polling interval, task timeout.
2. **New task**: choose model → the form adapts automatically → write the prompt → add media URLs per mode (must be publicly accessible `http(s)`) → submit.
3. **Track on the board**: tasks flow through queued → in-progress → completed/failed. Play or download when done.
4. **On failure**: view the error in the detail panel, or retry with the same parameters (creates a new task).

**V2.0 tip**: duration = `num_frames / frame_rate` (e.g. 121/24 ≈ 5s); `num_frames` must be ≤ 441 and follow 8n+1 (81/121/241/441).

## 🏗️ Project Layout

```
agnes-video-console/
├── server.js            # Express API + validation (per model family) + static files
├── db.js                # SQLite layer (tasks / settings / auto-migration)
├── agnes.js             # Agnes API client (create / query)
├── poller.js            # Background poller (backoff / timeout / stuck-task cleanup)
├── logger.js            # In-memory ring-buffer log
├── public/              # Frontend SPA (index.html / style.css / app.js)
├── test/mock-e2e.js     # End-to-end smoke test with a local fake Agnes API
└── data/                # Runtime: agnes-console.db (gitignored)
```

## 🧪 Testing

No real API key required — a local fake Agnes API verifies the whole create → poll → complete loop plus per-model validation:

```bash
npm run test:mock
```

Expected output: `== 全部通过 ✔ ==` (currently 18 checks). CI runs it on every push / PR.

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