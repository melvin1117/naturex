import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-24 text-center">
      <h1 className="font-serif text-5xl tracking-tight">Page not found</h1>
      <p className="mt-3 text-muted-foreground">
        That page doesn&apos;t exist. The site may have been removed when the
        demo was reset.
      </p>
      <Button asChild className="mt-6">
        <Link href="/">Back to the Marketplace</Link>
      </Button>
    </section>
  );
}
