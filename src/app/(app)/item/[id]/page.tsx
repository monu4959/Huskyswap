import { Suspense } from "react";
import { Splash } from "@/components/AppShell";
import { ItemDetail } from "./ItemDetail";

export default function ItemPage({ params }: PageProps<"/item/[id]">) {
  return (
    <Suspense fallback={<Splash />}>
      <ItemDetail params={params} />
    </Suspense>
  );
}
