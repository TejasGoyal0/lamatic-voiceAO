import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Allow ngrok and other dev origins
  allowedDevOrigins: [
    'aa1b-2409-40d4-107e-2dd-4ed0-c110-88ac-1871.ngrok-free.app',
    '*.ngrok-free.app',
    '*.ngrok.io',
  ],
};

export default nextConfig;
