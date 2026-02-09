/**
 * APPROACH 1: Lamatic-Only Voice Mode
 * =====================================
 * 
 * ARCHITECTURE:
 * - Transport: Direct getUserMedia (no Cloudflare RealtimeKit)
 * - STT: Lamatic (ElevenLabs STT)
 * - LLM: Lamatic (orchestration)
 * - TTS: Lamatic (ElevenLabs TTS) → Audio streamed back to browser
 * 
 * FLOW:
 * 1. Browser captures mic via getUserMedia
 * 2. Audio chunks sent to Lamatic webhook via fetch POST
 * 3. Lamatic performs STT → LLM → TTS
 * 4. Browser receives audio response and plays it
 * 
 * NO CLOUDFLARE REALTIMEKIT IN THIS ROUTE.
 */

import VoiceClient from '../../components/approach1/VoiceClient';

export default function Approach1Page() {
  return (
    <main className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-2xl mx-auto px-4">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Approach 1: Lamatic-Only Mode
          </h1>
          <p className="text-gray-600">
            Direct microphone → Lamatic (STT + LLM + TTS) → Audio playback
          </p>
          <div className="mt-4 p-4 bg-blue-50 rounded-lg text-sm text-blue-800">
            <strong>Architecture:</strong> No Cloudflare RealtimeKit. 
            Audio sent directly to Lamatic webhook.
          </div>
        </div>
        
        <VoiceClient />
      </div>
    </main>
  );
}
