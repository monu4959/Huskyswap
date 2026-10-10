import type { Metadata, Viewport } from "next";
import { Figtree, Sora } from "next/font/google";
import { StoreProvider } from "@/lib/store";
import { ToastProvider } from "@/components/ui";
import { APP_NAME } from "@/lib/constants";
import "./globals.css";

const sora = Sora({ variable: "--font-sora", subsets: ["latin"], weight: ["500", "600", "700"] });
const figtree = Figtree({ variable: "--font-figtree", subsets: ["latin"], weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Buy, sell and borrow with other Northeastern students.",
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#242c3b",
};

// Apply the saved theme before first paint (dark unless the user chose otherwise)
const THEME_SCRIPT = `try{document.documentElement.dataset.theme=localStorage.getItem("huskyswap-theme")||"dark"}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${sora.variable} ${figtree.variable} h-full`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">
        {/* shared gradient for the item illustrations */}
        <svg width="0" height="0" className="absolute" aria-hidden focusable="false">
          <defs>
            <linearGradient id="hs-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#34C8E8" />
              <stop offset="1" stopColor="#4E4AF2" />
            </linearGradient>
          </defs>
        </svg>
        <StoreProvider>
          <ToastProvider>{children}</ToastProvider>
        </StoreProvider>
      </body>
    </html>
  );
}
