import type { MetadataRoute } from "next";
import { APP_NAME } from "@/lib/constants";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_NAME,
    short_name: APP_NAME,
    description: "Buy, sell and borrow with other Northeastern students.",
    start_url: "/",
    display: "standalone",
    background_color: "#242c3b",
    theme_color: "#242c3b",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
