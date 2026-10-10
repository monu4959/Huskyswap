import { Suspense } from "react";
import { Splash } from "@/components/AppShell";
import { DealDetail } from "./DealDetail";

export default function DealPage({ params }: PageProps<"/deals/[id]">) {
  return (
    <Suspense fallback={<Splash />}>
      <DealDetail params={params} />
    </Suspense>
  );
}
