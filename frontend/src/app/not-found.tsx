import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 text-muted-foreground">
        That page doesn&apos;t exist. The asset may have been removed when the
        demo was reset.
      </p>
      <Button asChild className="mt-6">
        <Link href="/">Back to the marketplace</Link>
      </Button>
    </section>
  );
}
