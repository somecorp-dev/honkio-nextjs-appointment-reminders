import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Book an appointment',
  description: 'Appointment booking with a text confirmation and reminder, sent with HonkIO.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <footer>
          Texts sent with <a href="https://honkio.ca">HonkIO</a>
        </footer>
      </body>
    </html>
  );
}
