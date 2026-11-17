import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('security headers', () => {
  it('stops every page being framed, and keeps booking links out of referrers and search engines', async () => {
    const rules = await nextConfig.headers!();
    const forPath = (source: string) => Object.fromEntries(rules.find((r) => r.source === source)!.headers.map((h) => [h.key, h.value]));

    expect(forPath('/:path*')).toEqual({ 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' });
    expect(forPath('/bookings/:path*')).toEqual({ 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  });
});
