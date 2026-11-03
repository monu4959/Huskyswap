import type { Metadata, Viewport } from "next";
import { DM_Sans, Fraunces } from "next/font/google";
import { StoreProvider } from "@/lib/store";
import { ToastProvider } from "@/components/ui";
import { APP_NAME } from "@/lib/constants";
import "./globals.css";

// Fraunces: an editorial serif for display headings. DM Sans: everything else.
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], axes: ["opsz"] });
const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Buy, sell and borrow with other Northeastern students.",
  // "default": dark status-bar text on a light bar. The old "black-translucent" drew white
  // text over the page, which is invisible on the off-white background.
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#141211" },
  ],
};

// Apply the saved theme before first paint (the device's light or dark setting unless the user chose otherwise)
const THEME_SCRIPT = `try{document.documentElement.dataset.theme=localStorage.getItem("huskyswap-theme")||"system"}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="system" suppressHydrationWarning className={`${fraunces.variable} ${dmSans.variable} h-full`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <StoreProvider>
          <ToastProvider>{children}</ToastProvider>
        </StoreProvider>
      </body>
    </html>
  );
}
