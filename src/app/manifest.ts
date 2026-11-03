import type { MetadataRoute } from "next";
import { APP_NAME } from "@/lib/constants";

// Installs HuskySwap as a phone app ("Add to Home Screen"): full screen, portrait, its own icon.
// iOS takes its home-screen icon from src/app/apple-icon.png instead.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: APP_NAME,
    short_name: APP_NAME,
    description: "Buy, sell and borrow with other Northeastern students.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f5f2",
    theme_color: "#f7f5f2",
    categories: ["shopping", "education"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
