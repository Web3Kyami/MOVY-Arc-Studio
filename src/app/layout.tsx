import type { Metadata, Viewport } from 'next'
import { Plus_Jakarta_Sans, Geist_Mono } from 'next/font/google'
import { headers } from 'next/headers'
import './globals.css'
import { Providers } from './providers'

const plusJakartaSans = Plus_Jakarta_Sans({
  variable: '--font-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
})
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'MOVY — save the spare change',
  description: 'Build a savings habit with MOVY.',
  applicationName: 'MOVY',
  openGraph: {
    title: 'MOVY — save the spare change',
    description: 'Build a savings habit with MOVY.',
    type: 'website',
  },
}

export const viewport: Viewport = {
  themeColor: '#F7F8F5',
  width: 'device-width',
  initialScale: 1,
  // Not `user-scalable=no`: pinch zoom is an accessibility requirement.
  viewportFit: 'cover',
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers()
  const siteRole = requestHeaders.get('x-movy-site-role') === 'demo' ? 'demo' : 'product'
  const browserFixturesEnabled = process.env.MOVY_BROWSER_TEST_FIXTURES === 'true' && siteRole === 'product'
  return (
    <html
      lang="en"
      className={`${plusJakartaSans.variable} ${geistMono.variable} h-full antialiased font-sans`}
      suppressHydrationWarning
    >
      <body className="min-h-full">
        <Providers siteRole={siteRole} browserTestFixturesEnabled={browserFixturesEnabled}>{children}</Providers>
      </body>
    </html>
  )
}
