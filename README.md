# TabMind — Local Tab Saver (Built‑in AI)

A Chrome extension that saves tabs as rich, searchable notes with **on-device AI**: automatic **TL;DR**, **key points**, and **AI-generated tags** using Chrome's **Summarizer API** and **Prompt API**.

**Privacy:** 100% local. No servers or API keys. Works offline *after* the one‑time model download managed by Chrome.

## Features
- One‑click **Save current tab** → captures page text, generates TL;DR, key points, and tags (structured JSON).
- **Quick search** in the popup and a full **library** in the Side Panel.
- Natural‑language recall with local **re‑ranking** (Prompt API).
- Clean IndexedDB storage; no cloud sync.

## Install (Unpacked)
1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the folder `tabmind-extension`.
3. Pin **TabMind** from the toolbar and click it.
4. Click **Initialize AI** once to allow Chrome to download the on‑device models (one‑time).
   - You can monitor progress in the UI or at `chrome://on-device-internals`.

## How it stays local
- Uses **Summarizer API** (`Summarizer.create()` / `Summarizer.summarize`) for TL;DR and key points.
- Uses **Prompt API** (`LanguageModel.create()` / `session.prompt`) with a **JSON Schema** constraint to extract tags and for **semantic re‑rank** during search.
- These APIs are built into Chrome and run **Gemini Nano** locally (once downloaded).

## Known limitations (next polish ideas)
- Built‑in AI APIs are not available in service workers. All calls are made from the popup/side panel documents.
- For very large libraries, consider adding an OPFS/IndexDB full‑text index and chunked re‑ranking.
- Initial model download requires a user gesture and sufficient disk space (see docs).

## Docs
- Prompt API (Gemini Nano in-browser): https://developer.chrome.com/docs/ai/prompt-api
- Summarizer API (Chrome 138+): https://developer.chrome.com/docs/ai/summarizer-api
- Extensions + AI overview: https://developer.chrome.com/docs/extensions/ai
