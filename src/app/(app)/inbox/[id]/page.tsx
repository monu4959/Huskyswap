import { Suspense } from "react";
import { Splash } from "@/components/AppShell";
import { Chat } from "./Chat";

export default function ChatPage({ params }: PageProps<"/inbox/[id]">) {
  return (
    <Suspense fallback={<Splash />}>
      <Chat params={params} />
    </Suspense>
  );
}
