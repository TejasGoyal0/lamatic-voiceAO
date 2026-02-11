import Link from 'next/link';

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-4xl mx-auto px-4">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            Voice AI Demo
          </h1>
          <p className="text-lg text-gray-600">
            Two independent voice architectures for comparison
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          <Link href="/approach-1" className="block">
            <div className="bg-white rounded-xl shadow-lg p-8 hover:shadow-xl transition-shadow cursor-pointer border-2 border-transparent hover:border-blue-500">
              <div className="text-center mb-6">
                <div className="inline-block p-4 bg-blue-100 rounded-full mb-4">
                  <svg className="w-12 h-12 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  Approach 1
                </h2>
                <p className="text-blue-600 font-medium">
                  Lamatic-Only Mode
                </p>
              </div>

              <div className="space-y-3 text-sm text-gray-600">
                <div className="flex items-start gap-2">
                  <span className="text-blue-500 font-bold">1.</span>
                  <span><strong>Transport:</strong> Direct getUserMedia</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-blue-500 font-bold">2.</span>
                  <span><strong>STT:</strong> Lamatic (ElevenLabs)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-blue-500 font-bold">3.</span>
                  <span><strong>LLM:</strong> Lamatic</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-blue-500 font-bold">4.</span>
                  <span><strong>TTS:</strong> Lamatic (ElevenLabs)</span>
                </div>
              </div>

              <div className="mt-6 p-3 bg-blue-50 rounded-lg text-xs text-blue-700">
                No Cloudflare RealtimeKit. Audio sent directly to Lamatic webhook.
              </div>
            </div>
          </Link>

          <Link href="/approach-2" className="block">
            <div className="bg-white rounded-xl shadow-lg p-8 hover:shadow-xl transition-shadow cursor-pointer border-2 border-transparent hover:border-purple-500">
              <div className="text-center mb-6">
                <div className="inline-block p-4 bg-purple-100 rounded-full mb-4">
                  <svg className="w-12 h-12 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  Approach 2
                </h2>
                <p className="text-purple-600 font-medium">
                  Cloudflare + External STT
                </p>
              </div>

              <div className="space-y-3 text-sm text-gray-600">
                <div className="flex items-start gap-2">
                  <span className="text-purple-500 font-bold">1.</span>
                  <span><strong>Transport:</strong> Cloudflare RealtimeKit</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-purple-500 font-bold">2.</span>
                  <span><strong>STT:</strong> ElevenLabs (external)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-purple-500 font-bold">3.</span>
                  <span><strong>LLM:</strong> Lamatic (receives transcript)</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-purple-500 font-bold">4.</span>
                  <span><strong>TTS:</strong> Optional (Lamatic trigger)</span>
                </div>
              </div>

              <div className="mt-6 p-3 bg-purple-50 rounded-lg text-xs text-purple-700">
                Uses Cloudflare RealtimeKit for WebRTC streaming. STT happens outside Lamatic.
              </div>
            </div>
          </Link>
        </div>

        <div className="mt-12 bg-white rounded-xl shadow-lg p-8">
          <h3 className="text-xl font-bold text-gray-900 mb-6 text-center">
            Architecture Comparison
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-3 px-4">Feature</th>
                  <th className="text-left py-3 px-4 text-blue-600">Approach 1</th>
                  <th className="text-left py-3 px-4 text-purple-600">Approach 2</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr className="border-b">
                  <td className="py-3 px-4 font-medium">Audio Transport</td>
                  <td className="py-3 px-4">Direct fetch POST</td>
                  <td className="py-3 px-4">Cloudflare WebRTC</td>
                </tr>
                <tr className="border-b">
                  <td className="py-3 px-4 font-medium">STT Provider</td>
                  <td className="py-3 px-4">Inside Lamatic</td>
                  <td className="py-3 px-4">External (Browser)</td>
                </tr>
                <tr className="border-b">
                  <td className="py-3 px-4 font-medium">Latency</td>
                  <td className="py-3 px-4">Higher (audio upload)</td>
                  <td className="py-3 px-4">Lower (streaming)</td>
                </tr>
                <tr className="border-b">
                  <td className="py-3 px-4 font-medium">Complexity</td>
                  <td className="py-3 px-4">Simpler</td>
                  <td className="py-3 px-4">More complex</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 font-medium">Real-time transcript</td>
                  <td className="py-3 px-4">No</td>
                  <td className="py-3 px-4">Yes</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}
