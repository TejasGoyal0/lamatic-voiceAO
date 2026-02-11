# Voice AI Platform

A real-time voice AI assistant built with Next.js that uses **Lamatic.ai** as its middleware orchestrator. Two distinct architectures are implemented side-by-side for comparison:

- **Approach 1 (Lamatic-Only):** Captures audio locally and sends it directly to Lamatic for STT → LLM → TTS processing in a single roundtrip.
- **Approach 2 (Cloudflare + External STT):** Streams audio via Cloudflare RealtimeKit (WebRTC), performs STT externally with ElevenLabs, and sends transcripts to Lamatic for LLM processing with separate TTS.

---

## Architecture

### Approach 1 — Lamatic-Only

```
Browser                         Next.js Server                 Lamatic.ai
┌──────────────┐                ┌──────────────┐              ┌──────────────┐
│ getUserMedia  │                │              │              │              │
│      ↓        │                │              │              │  STT Node    │
│ AudioCapture  │  WAV blob      │  /api/lamatic│  GraphQL     │      ↓       │
│  (VAD)        │───────────────►│  (proxy)     │─────────────►│  LLM Node    │
│      ↓        │                │              │◄─────────────│      ↓       │
│ playAudio()   │◄───────────────│              │  text+audio  │  TTS Node    │
└──────────────┘   base64 audio  └──────────────┘              └──────────────┘
```

**Data flow:**

1. `AudioCapture` uses the Web Audio API and a custom VAD to detect speech/silence.
2. On pause detection (configurable silence threshold), the captured PCM audio is encoded to WAV.
3. The WAV blob is base64-encoded and sent to `/api/lamatic` (Next.js API route).
4. The server-side proxy triggers a Lamatic GraphQL workflow that handles STT → LLM → TTS.
5. The response (text + base64 audio) is returned to the client for playback.

**Key files:**
| File | Purpose |
|------|---------|
| `components/approach1/VoiceClient.tsx` | UI component, state management, audio playback |
| `lib/approach1/lamatic-client.ts` | API client with `AbortController` for barge-in |
| `lib/approach1/audio-capture.ts` | Microphone capture + VAD + WAV encoding |
| `lib/approach1/wav-encoder.ts` | PCM → WAV encoding utility |
| `app/api/lamatic/route.ts` | Server-side Lamatic GraphQL proxy |

---

### Approach 2 — Cloudflare + External STT

```
Browser                         Next.js Server                 External APIs
┌──────────────┐                ┌──────────────┐              ┌──────────────┐
│ RealtimeKit   │  WebRTC        │              │              │              │
│ (audio stream)│~~~~~~~~~~~~~~~~│  /api/join   │              │  Cloudflare  │
│      ↓        │                │              │              │  RealtimeKit │
│  STTClient    │───────────────►│  /api/       │─────────────►│              │
│ (ElevenLabs)  │  audio chunks  │  transcribe  │  ElevenLabs  │  STT API     │
│      ↓        │                │              │              └──────────────┘
│ LamaticClient │───────────────►│  /api/lamatic│─────────────►┌──────────────┐
│ (transcript)  │  text          │  (proxy)     │  GraphQL     │  Lamatic.ai  │
│      ↓        │                │              │◄─────────────│  LLM Node    │
│  TTSClient    │───────────────►│  /api/tts    │─────────────►└──────────────┘
│ (ElevenLabs)  │  text          │              │  ElevenLabs  ┌──────────────┐
│  playback     │◄───────────────│              │  stream      │  TTS API     │
└──────────────┘   audio stream  └──────────────┘              └──────────────┘
```

**Data flow:**

1. `RealtimeKitClient` connects to Cloudflare via WebRTC and exposes the local `MediaStream`.
2. `STTClient` takes the MediaStream, chunks it into WebM, and sends it to ElevenLabs for transcription.
3. On pause detection (local VAD), the current transcript is flushed and sent to Lamatic via `LamaticClient`.
4. The LLM response text is passed to `TTSClient`, which streams audio from ElevenLabs TTS API.

**Key files:**
| File | Purpose |
|------|---------|
| `components/approach2/VoiceClient.tsx` | UI component, orchestrates all clients |
| `lib/approach2/realtimekit-client.ts` | Cloudflare WebRTC connection + local VAD |
| `lib/approach2/stt-client.ts` | ElevenLabs STT via `/api/transcribe` proxy |
| `lib/approach2/lamatic-client.ts` | Sends transcript to Lamatic LLM |
| `lib/approach2/tts-client.ts` | ElevenLabs TTS streaming playback |
| `app/api/join/route.ts` | Creates Cloudflare meeting + auth token |
| `app/api/transcribe/route.ts` | ElevenLabs STT proxy |
| `app/api/tts/route.ts` | ElevenLabs TTS streaming proxy |

---

## Lamatic as Middleware

Both approaches use [Lamatic.ai](https://lamatic.ai) as the central middleware layer. Lamatic orchestrates multi-step GenAI workflows via a visual flow builder, combining STT, LLM, TTS, and RAG nodes into a single pipeline.

### How it works

1. **Workflow trigger:** The Next.js API route (`/api/lamatic`) sends a GraphQL `executeWorkflow` mutation to Lamatic's API.
2. **Async processing:** The workflow runs asynchronously. The server polls `checkStatus` until it completes.
3. **Pipeline nodes:** Inside Lamatic, the workflow executes nodes in sequence (e.g., ElevenLabs STT → GPT LLM → ElevenLabs TTS).
4. **Response extraction:** The server extracts text and optional audio from the workflow output and returns it to the client.

### Why Lamatic

| Benefit                  | Detail                                                                      |
| ------------------------ | --------------------------------------------------------------------------- |
| **No vendor lock-in**    | Swap STT/LLM/TTS providers by changing Lamatic nodes, not code              |
| **Single API surface**   | One GraphQL endpoint for the entire voice pipeline                          |
| **Visual orchestration** | Build and iterate on voice flows without redeploying                        |
| **RAG support**          | Add knowledge bases, vector search, and context injection via Lamatic nodes |

---

## Latency Benchmarking

Measured end-to-end roundtrip latency from VAD pause trigger to first audio playback. Values are based on real-world testing and vary with network conditions, audio length, and LLM response size.

| Metric                      | Approach 1 (Lamatic-Only) | Approach 2 (Cloudflare + STT) |
| --------------------------- | ------------------------- | ----------------------------- |
| **End-to-end roundtrip**    | **25–30s**                | **8–14s**                     |
| **Lamatic flow execution**  | ~14s                      | ~4–7s                         |
| **Client/network overhead** | ~11–16s                   | ~4–7s                         |
| **Audio upload**            | base64 WAV POST           | N/A (WebRTC stream)           |
| **STT**                     | Inside Lamatic flow       | ElevenLabs direct (parallel)  |
| **TTS**                     | Inside Lamatic flow       | ElevenLabs stream (parallel)  |
| **Real-time transcript**    | No                        | Yes (partial updates)         |
| **Barge-in support**        | Yes (`AbortController`)   | Yes (VAD interrupt)           |

### Why Approach 1 is ~3x slower

- Audio is base64-encoded and uploaded as a full POST body (~11–16s of client/network overhead alone).
- STT + LLM + TTS run **sequentially** within a single Lamatic workflow — no parallelism.
- The Lamatic flow handles the full pipeline (STT → LLM → TTS), resulting in ~14s flow execution.
- Polling adds additional latency between workflow completion and response delivery.

### Why Approach 2 is ~2–3x faster

- Audio streams via WebRTC with near-zero upload latency — no base64 encoding overhead.
- STT runs **in parallel** with audio capture (chunked transcription happens as the user speaks).
- Lamatic only handles LLM (no STT/TTS), cutting flow execution to ~4–7s.
- TTS streams audio as it generates, allowing playback to start before the full response is ready.

---

## Shared Components

| File                                | Purpose                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| `lib/voice-capture.ts`              | Core VAD engine using Web Audio API (used by local testing) |
| `lib/voice-session.ts`              | Orchestrates VoiceCapture + RealtimeKitTransport            |
| `lib/voice-session-local.ts`        | Standalone VAD session (no Cloudflare)                      |
| `lib/realtimekit-transport.ts`      | Cloudflare RealtimeKit WebRTC transport                     |
| `lib/lamatic-graphql-client.ts`     | Direct Lamatic GraphQL client (not used by approach routes) |
| `components/VoiceUILocal.tsx`       | Local VAD testing UI (no AI processing)                     |
| `app/api/lamatic-callback/route.ts` | Long-polling callback endpoint for Lamatic webhooks         |

---

## Setup

### Prerequisites

- Node.js 18+
- npm

### Environment Variables

Create a `.env.local` file:

```env
# Lamatic
LAMATIC_API_KEY=your_lamatic_api_key
LAMATIC_PROJECT_ID=your_project_id
LAMATIC_WORKFLOW_ID=your_workflow_id

# ElevenLabs (Approach 2)
ELEVENLABS_API_KEY=your_elevenlabs_api_key

# Cloudflare RealtimeKit (Approach 2)
CF_ACCOUNT_ID=your_cloudflare_account_id
CF_API_TOKEN=your_cloudflare_api_token
REALTIMEKIT_APP_ID=your_realtimekit_app_id
REALTIMEKIT_PRESET_NAME=group_call_host
```

### Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and choose an approach.

---

## Project Structure

```
nextjs-voice/
├── app/
│   ├── page.tsx                    # Home — approach selector
│   ├── layout.tsx                  # Root layout
│   ├── approach-1/page.tsx         # Approach 1 page
│   ├── approach-2/page.tsx         # Approach 2 page
│   └── api/
│       ├── lamatic/route.ts        # Lamatic GraphQL proxy
│       ├── lamatic-callback/route.ts # Long-polling callback
│       ├── join/route.ts           # Cloudflare RealtimeKit auth
│       ├── transcribe/route.ts     # ElevenLabs STT proxy
│       └── tts/route.ts           # ElevenLabs TTS proxy
├── components/
│   ├── approach1/VoiceClient.tsx   # Approach 1 UI
│   ├── approach2/VoiceClient.tsx   # Approach 2 UI
│   └── VoiceUILocal.tsx            # Local VAD testing
├── lib/
│   ├── approach1/                  # Approach 1 client libraries
│   ├── approach2/                  # Approach 2 client libraries
│   ├── voice-capture.ts            # Core VAD engine
│   ├── voice-session.ts            # Session orchestrator
│   ├── voice-session-local.ts      # Local session (no Cloudflare)
│   ├── realtimekit-transport.ts    # WebRTC transport layer
│   └── lamatic-graphql-client.ts   # Direct GraphQL client
└── package.json
```
