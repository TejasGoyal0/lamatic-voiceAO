# Voice Capture with Cloudflare RealtimeKit

A browser-based voice capture system with real-time Voice Activity Detection (VAD), pause detection, and low-latency audio streaming via Cloudflare RealtimeKit.

## What It Does

1. **Captures audio** from your microphone via Cloudflare RealtimeKit SDK
2. **Analyzes speech** in real-time using Web Audio API
3. **Detects pauses** (3+ seconds of silence) to identify segment boundaries
4. **Sends control messages** through RealtimeKit when pauses are detected
5. **Visualizes** energy levels and speech state in the UI

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                                    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  RealtimeKitTransport                                               │   │
│  │  ┌─────────────────┐    ┌─────────────────┐                         │   │
│  │  │ RealtimeKit SDK │───▶│   MediaStream   │──────┐                  │   │
│  │  │ (owns mic)      │    │   (audio track) │      │                  │   │
│  │  └─────────────────┘    └─────────────────┘      │                  │   │
│  │          │                                       │                  │   │
│  │          ▼                                       │                  │   │
│  │  ┌─────────────────┐                             │                  │   │
│  │  │  Cloudflare SFU │ ◀── Audio streaming         │                  │   │
│  │  │  (WebRTC)       │                             │                  │   │
│  │  └─────────────────┘                             │                  │   │
│  │          │                                       │                  │   │
│  │          ▼                                       ▼                  │   │
│  │  ┌─────────────────┐                   ┌─────────────────────┐     │   │
│  │  │  Chat Channel   │ ◀── PAUSE/        │    VoiceCapture     │     │   │
│  │  │  (control msgs) │     SPEECH_START  │    (analysis only)  │     │   │
│  │  └─────────────────┘                   │                     │     │   │
│  │                                        │  AudioContext       │     │   │
│  └────────────────────────────────────────│  AnalyserNode       │─────┘   │
│                                           │  VAD Algorithm      │         │
│  ┌─────────────────────────────────────┐  │  Pause Detection    │         │
│  │  VoiceSession (Orchestration)       │  └─────────────────────┘         │
│  │  - Coordinates Transport + Capture  │                                  │
│  │  - Handles events                   │                                  │
│  └─────────────────────────────────────┘                                  │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  VoiceUI (React Component)                                          │   │
│  │  - Start/Stop buttons                                               │   │
│  │  - Energy meter visualization                                       │   │
│  │  - Status indicators                                                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                              │
                              │ POST /api/join
                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  SERVER (Next.js API Route)                                                 │
│                                                                             │
│  /api/join                                                                  │
│  1. Creates a meeting via Cloudflare API                                    │
│  2. Adds participant to meeting                                             │
│  3. Returns authToken to client                                             │
│                                                                             │
│  Environment variables (server-only):                                       │
│  - CF_ACCOUNT_ID                                                            │
│  - CF_API_TOKEN                                                             │
│  - REALTIMEKIT_APP_ID                                                       │
│  - REALTIMEKIT_PRESET_NAME                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## VAD Algorithm

The Voice Activity Detection uses several techniques for robust speech detection:

### 1. Adaptive Noise Floor Calibration
- First 500ms: Samples ambient noise to establish baseline
- Noise floor updates slowly during silence periods

### 2. RMS Energy Computation
```
energy = sqrt(sum(sample²) / numSamples)
```

### 3. Hysteresis Thresholds
- **Speech threshold**: `noiseFloor × 1.3` (to start speaking)
- **Silence threshold**: `noiseFloor × 1.0` (to stop speaking)
- Prevents rapid toggling at boundary

### 4. EMA Smoothing
```
smoothedEnergy = 0.7 × previousEnergy + 0.3 × currentEnergy
```

### 5. Pause Detection
- Triggers after **3 seconds** of continuous silence
- Increments segment counter
- Sends `PAUSE` control message

## Control Messages

When events occur, JSON messages are sent through RealtimeKit's chat channel:

### PAUSE Message
```json
{
  "type": "PAUSE",
  "segment": 1,
  "silenceDuration": 3016,
  "timestamp": 1770292406270
}
```

### SPEECH_START Message
```json
{
  "type": "SPEECH_START",
  "timestamp": 1770292417502
}
```

These messages can be received by other participants or a server-side bot in the same meeting.

## Setup

### 1. Install Dependencies

```bash
cd nextjs-voice
npm install
```

### 2. Configure Environment

```bash
cp .env.local.example .env.local
```

Edit `.env.local` with your Cloudflare credentials:

| Variable | Where to Find |
|----------|---------------|
| `CF_ACCOUNT_ID` | Cloudflare Dashboard → Account ID (sidebar) |
| `CF_API_TOKEN` | dash.cloudflare.com/profile/api-tokens → Create Token with "Realtime: Admin" |
| `REALTIMEKIT_APP_ID` | dash.cloudflare.com → Realtime → Kit → Your App |
| `REALTIMEKIT_PRESET_NAME` | Your preset name (e.g., `group_call_host`) |

### 3. Run Development Server

```bash
npm run dev
```

### 4. Open in Browser

Navigate to [http://localhost:3000](http://localhost:3000)

## File Structure

```
nextjs-voice/
├── app/
│   ├── api/
│   │   └── join/
│   │       └── route.ts      # Server: Creates meeting, returns authToken
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx              # Main page
├── components/
│   ├── VoiceUI.tsx           # Cloudflare-enabled UI
│   └── VoiceUILocal.tsx      # Local-only UI (no Cloudflare)
├── lib/
│   ├── voice-capture.ts      # VAD + pause detection
│   ├── realtimekit-transport.ts  # SDK wrapper, owns MediaStream
│   ├── voice-session.ts      # Orchestration (Cloudflare mode)
│   └── voice-session-local.ts    # Orchestration (local mode)
├── .env.local.example
├── package.json
└── README.md
```

## Key Design Decisions

### 1. MediaStream Ownership
The **RealtimeKitTransport** owns the microphone:
- SDK calls `getUserMedia()` internally
- Provides stream to VoiceCapture for analysis
- Ensures single point of control

### 2. Client/Server Separation
- **Server**: Holds API credentials, mints tokens
- **Client**: All audio processing, no secrets exposed

### 3. Chat as Control Channel
RealtimeKit's chat feature is repurposed for control messages:
- No additional infrastructure needed
- Messages reach all participants instantly
- Can be received by server-side bots

## Usage

1. Click **Start Recording**
2. Speak into your microphone
3. Watch the energy meter respond
4. After 3 seconds of silence → **PAUSE detected**
5. Segment counter increments
6. Control message sent via RealtimeKit

## Console Logging

The app outputs detailed logs to the browser console:

```
✓ RealtimeKit connected
✓ Voice capture started (analysis mode)
───────────────────────────────────────────
🎤 SPEECH STARTED
  Energy: 0.0508
  After silence: 1.05 ms
───────────────────────────────────────────
📤 Sending SPEECH_START control message...
✓ Message sent via chat channel

═══════════════════════════════════════════
⏸ PAUSE DETECTED
  Segment: 1
  Silence duration: 3016 ms
  Noise floor: 0.0025
  Threshold: 0.0150
═══════════════════════════════════════════
📤 Sending PAUSE control message...
✓ Message sent via chat channel
```

## Local Mode (No Cloudflare)

To test without Cloudflare credentials, edit `app/page.tsx`:

```tsx
// import VoiceUI from '../components/VoiceUI';
import VoiceUILocal from '../components/VoiceUILocal';

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50 py-12">
      <VoiceUILocal />
    </main>
  );
}
```

Local mode uses direct `getUserMedia()` and only does VAD locally (no streaming).

## Browser Requirements

- Modern browser (Chrome, Firefox, Edge, Safari)
- HTTPS or localhost (required for microphone access)
- Microphone permission granted

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Authentication error" | Check API token has "Realtime: Admin" permission |
| "No meeting ID" | Verify REALTIMEKIT_APP_ID exists in dashboard |
| Microphone not working | Check browser permissions, use HTTPS |
| Concurrent init error | Don't click Start multiple times rapidly |

## Next Steps

Potential enhancements:
- [ ] Server-side bot to receive pause events
- [ ] Transcription integration on pause
- [ ] Multi-participant support
- [ ] Recording segments between pauses
- [ ] WebSocket fallback for control messages
