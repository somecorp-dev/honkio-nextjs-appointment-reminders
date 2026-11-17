import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookingFormUrl, business, textPolicy } from '../lib/config';

beforeEach(() => {
  vi.stubEnv('BUSINESS_NAME', 'Acme Clinic');
  vi.stubEnv('BUSINESS_CONTACT', '100 King St W, Toronto ON, hello@example.com');
  vi.stubEnv('BUSINESS_TIMEZONE', 'America/Toronto');
  vi.stubEnv('REMINDER_HOURS_BEFORE', '');
  vi.stubEnv('APP_URL', '');
  vi.stubEnv('CONFIRM_PHONE', '');
  vi.stubEnv('ALLOW_UNCONFIRMED_BOOKINGS', '');
});

afterEach(() => vi.unstubAllEnvs());

describe('business', () => {
  it('reads the business settings, with a 24-hour reminder by default', () => {
    expect(business()).toEqual({
      name: 'Acme Clinic',
      contact: '100 King St W, Toronto ON, hello@example.com',
      timeZone: 'America/Toronto',
      reminderHoursBefore: 24,
    });
  });

  it('requires BUSINESS_CONTACT, which CASL wants next to the opt-in box', () => {
    vi.stubEnv('BUSINESS_CONTACT', '  ');
    expect(() => business()).toThrow('BUSINESS_CONTACT is not set. Copy .env.example to .env.local and fill it in.');
  });

  it('refuses the example name and contact details in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => business()).toThrow(/BUSINESS_NAME is still the example value/);
    vi.stubEnv('BUSINESS_NAME', '');
    expect(() => business()).toThrow(/BUSINESS_NAME is still the example value \("Acme Clinic"\)/);
    vi.stubEnv('BUSINESS_NAME', 'Maple Dental');
    expect(() => business()).toThrow(/BUSINESS_CONTACT is still the example value/);
    vi.stubEnv('BUSINESS_CONTACT', '12 Elgin St, Ottawa ON, front@EXAMPLE.com');
    expect(() => business()).toThrow(/BUSINESS_CONTACT/);
    vi.stubEnv('BUSINESS_CONTACT', '12 Elgin St, Ottawa ON, front@mapledental.ca');
    expect(business()).toMatchObject({ name: 'Maple Dental', contact: '12 Elgin St, Ottawa ON, front@mapledental.ca' });
  });

  it('allows a name that only contains the example one', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BUSINESS_NAME', 'Acme Clinic West');
    vi.stubEnv('BUSINESS_CONTACT', '12 Elgin St, Ottawa ON, front@mapledental.ca');
    expect(business().name).toBe('Acme Clinic West');
  });

  it.each(['1', '48', '720'])('accepts REMINDER_HOURS_BEFORE=%s', (hours) => {
    vi.stubEnv('REMINDER_HOURS_BEFORE', hours);
    expect(business().reminderHoursBefore).toBe(Number(hours));
  });

  it.each(['0', '721', '1.5', '-3', 'a day'])('refuses REMINDER_HOURS_BEFORE=%s', (hours) => {
    vi.stubEnv('REMINDER_HOURS_BEFORE', hours);
    expect(() => business()).toThrow(/REMINDER_HOURS_BEFORE must be a whole number of hours from 1 to 720/);
  });
});

describe('bookingFormUrl', () => {
  it('is undefined until APP_URL is set', () => {
    expect(bookingFormUrl()).toBeUndefined();
  });

  it('reads APP_URL as a full address', () => {
    vi.stubEnv('APP_URL', 'https://book.example.com');
    expect(bookingFormUrl()).toBe('https://book.example.com/');
  });

  it('refuses an APP_URL that is not an http(s) address', () => {
    vi.stubEnv('APP_URL', 'book.example.com');
    expect(() => bookingFormUrl()).toThrow(/APP_URL/);
    vi.stubEnv('APP_URL', 'javascript:alert(1)');
    expect(() => bookingFormUrl()).toThrow(/APP_URL/);
  });

  it('refuses an APP_URL longer than HonkIO keeps', () => {
    vi.stubEnv('APP_URL', `https://book.example.com/${'a'.repeat(2048)}`);
    expect(() => bookingFormUrl()).toThrow(/2048/);
  });
});

describe('textPolicy', () => {
  it('texts numbers as typed in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(textPolicy()).toBe('send');
  });

  it('refuses to text unconfirmed numbers in production by default', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(textPolicy()).toBe('refuse');
    vi.stubEnv('ALLOW_UNCONFIRMED_BOOKINGS', 'yes');
    expect(textPolicy()).toBe('refuse');
  });

  it('texts unconfirmed numbers in production only with ALLOW_UNCONFIRMED_BOOKINGS=true', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_UNCONFIRMED_BOOKINGS', 'true');
    expect(textPolicy()).toBe('send');
  });

  it('confirms the number first with CONFIRM_PHONE=true, in development and production', () => {
    vi.stubEnv('CONFIRM_PHONE', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    expect(textPolicy()).toBe('confirm');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOW_UNCONFIRMED_BOOKINGS', 'true');
    expect(textPolicy()).toBe('confirm');
  });
});
