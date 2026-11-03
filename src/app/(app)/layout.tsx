import { Suspense, type ReactNode } from "react";
import { AppFrame, AuthGate } from "@/components/AppShell";
import { HuskyAssistant } from "@/components/HuskyChat";
import { MobileHeader, TabBar, TopNav } from "@/components/TabBar";

// The demo signs in through localStorage, so this area renders only in the browser
// and can't produce an instant server UI. Revisit once Supabase auth runs on the server.
export const instant = false;

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppFrame>
      <AuthGate>
        <Suspense fallback={null}>
          <TopNav />
          <MobileHeader />
        </Suspense>
        {children}
        <Suspense fallback={null}>
          <TabBar />
          <HuskyAssistant />
        </Suspense>
      </AuthGate>
    </AppFrame>
  );
}
