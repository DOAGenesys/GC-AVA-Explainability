import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Ingestion holds Genesys tokens and talks to the Platform API, so it must never be
  // statically evaluated or bundled for the edge.
  serverExternalPackages: ['@vercel/postgres'],
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'x-content-type-options', value: 'nosniff' },
        { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
        { key: 'x-frame-options', value: 'DENY' },
        {
          key: 'strict-transport-security',
          value: 'max-age=63072000; includeSubDomains; preload',
        },
      ],
    },
  ],
};

export default config;
