import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        // No site may show these pages in a frame, so the booking form can't
        // be laid under someone else's page to steal clicks. CSP
        // frame-ancestors for current browsers, X-Frame-Options for older ones.
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        // A booking page's link is the only key to the booking: keep it out
        // of the Referer header sent to other sites, and out of search engines.
        source: '/bookings/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex' },
        ],
      },
    ];
  },
};

export default nextConfig;
