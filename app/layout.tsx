import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Monetize — Revenue Intelligence',
  description: 'Seu centro de inteligência de monetização.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR" suppressHydrationWarning><body>{children}</body></html>;
}
