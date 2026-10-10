import { Suspense, type ReactNode } from "react";
import { AuthGate, PhoneFrame } from "@/components/AppShell";
import { TabBar } from "@/components/TabBar";

// The demo signs in through localStorage, so this area renders only in the browser
// and can't produce an instant server UI. Revisit once Supabase auth runs on the server.
export const instant = false;

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <PhoneFrame>
      <AuthGate>
        {children}
        <Suspense fallback={null}>
          <TabBar />
        </Suspense>
      </AuthGate>
    </PhoneFrame>
  );
}
