/**
 * APPROACH 2: Cloudflare RealtimeKit + External STT Mode
 * =======================================================
 * 
 * ARCHITECTURE:
 * - Transport: Cloudflare RealtimeKit (WebRTC)
 * - STT: ElevenLabs (external, from browser or server)
 * - LLM: Lamatic (receives transcript on PAUSE)
 * - TTS: Lamatic (optional trigger) or external
 * 
 * FLOW:
 * 1. Browser streams mic to Cloudflare RealtimeKit
 * 2. Audio is captured locally for STT processing
 * 3. STT happens via ElevenLabs (outside Lamatic)
 * 4. On PAUSE, final transcript is sent to Lamatic webhook
 * 5. Lamatic performs LLM orchestration
 * 6. Response can trigger TTS playback
 * 
 * USES CLOUDFLARE REALTIMEKIT FOR AUDIO TRANSPORT.
 */

import VoiceClient from '../../components/approach2/VoiceClient';

export default function Approach2Page() {
  return (
    <main className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-2xl mx-auto px-4">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Approach 2: Cloudflare + External STT
          </h1>
          <p className="text-gray-600">
            RealtimeKit streaming → ElevenLabs STT → Lamatic LLM → TTS
          </p>
          <div className="mt-4 p-4 bg-purple-50 rounded-lg text-sm text-purple-800">
            <strong>Architecture:</strong> Cloudflare RealtimeKit for transport. 
            STT external (ElevenLabs). Transcript sent to Lamatic for LLM.
          </div>
        </div>
        
        <VoiceClient />
      </div>
    </main>
  );
}
