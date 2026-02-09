import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Voice Capture Demo',
  description: 'Browser-based voice capture with Cloudflare RealtimeKit',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
