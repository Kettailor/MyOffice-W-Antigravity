import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import Script from 'next/script';
import { getLang, getT } from '@/i18n/server';
// One stylesheet per area of the screen, in cascade order (later files override earlier ones).
import '@/styles/fonts.css';
import '@/styles/base.css';
import '@/styles/topbar.css';
import '@/styles/topbar-plan.css';
import '@/styles/sidebars.css';
import '@/styles/activity.css';
import '@/styles/sessions.css';
import '@/styles/streamer.css';
import '@/styles/permissions.css';
import '@/styles/stage.css';
import '@/styles/labels.css';
import '@/styles/lite.css';
import '@/styles/timeline.css';
import '@/styles/places.css';
import '@/styles/csgt.css';
import '@/styles/todos.css';
import '@/styles/drawers.css';
import '@/styles/chat.css';
import '@/styles/group-chat.css';
import '@/styles/mac.css';
import '@/styles/modal.css';
import '@/styles/replay.css';
import '@/styles/photo.css';
import '@/styles/tips.css';
import '@/styles/settings.css';
import '@/styles/responsive.css';
import '@/styles/phone.css';
import '@/styles/antigravity.css';

/* The page's title, description and share card (the image and icons are files in app/: opengraph-image.jpg,
   twitter-image.jpg, icon.svg, favicon.ico, apple-icon.png). The online demo knows its address (OFFICE_SITE_URL, set by
   the Pages workflow), so links shared on Facebook, Zalo or X get an absolute image and one URL per language. */
const SITE = process.env.OFFICE_SITE_URL || '', ROOT = process.env.NEXT_PUBLIC_SITE_ROOT || '';
export async function generateMetadata(): Promise<Metadata> {
  const lang = await getLang(), t = await getT();
  const title = t('ui.meta.title'), description = t('ui.meta.description');
  const at = (sub: string) => `${SITE}${ROOT}${sub}`, url = at(lang === 'en' ? '/' : `/${lang}/`);
  const fallbackBase = `http://localhost:${process.env.OFFICE_PORT || 4310}`;
  return {
    metadataBase: new URL(SITE || fallbackBase),
    title: { absolute: 'My Office' }, description, applicationName: 'My Office',
    keywords: ['Claude Code', 'AI agents', '3D office', 'developer tools', 'văn phòng 3D', 'Claude Code dashboard'],
    openGraph: { type: 'website', siteName: 'My Office', title, description, locale: lang === 'vi' ? 'vi_VN' : 'en_US', ...(SITE && { url }) },
    twitter: { card: 'summary_large_image', title, description },
    ...(SITE && { alternates: { canonical: url, languages: { en: at('/'), vi: at('/vi/') } } }),
  };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#0E131B' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const osAttr =
    process.env.OFFICE_STATIC === '1'
      ? 'darwin'
      : process.env.OFFICE_DOCKER === '1'
      ? 'win32'
      : process.platform;
  const extGuardScript = `(function(){
    function isExtNoise(msg, stack) {
      var s = String(msg || '') + ' ' + String(stack || '');
      return /chrome-extension:\\/\\/|moz-extension:\\/\\/|reading 'useCache'|Receiving end does not exist|Extension context invalidated|message port closed before a response/i.test(s);
    }
    window.addEventListener('unhandledrejection', function(ev) {
      var r = ev && ev.reason;
      var msg = r && (r.message || String(r));
      var stack = r && r.stack;
      if (isExtNoise(msg, stack)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    }, true);
    window.addEventListener('error', function(ev) {
      if (isExtNoise(ev && ev.message, ev && ev.filename)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    }, true);
  })();`;
  return (
    // data-os: the machine's platform, for the words "Mac" / "PC" / "computer" (the online demo is a pretend Mac)
    <html lang={await getLang()} data-os={osAttr}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: extGuardScript }} />
      </head>
      <body>
        {children}
        {/* QR codes for "open on your phone" (qrcode.js, MIT), kept local so the office works offline */}
        <Script src={`${process.env.NEXT_PUBLIC_BASE_PATH || ''}/assets/vendor/qrcode.min.js`} strategy="afterInteractive" />
      </body>
    </html>
  );
}
