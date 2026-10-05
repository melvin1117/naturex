import { FlaskConical } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";

export const SANDBOX_NOTICE = "Sandbox: play money, not a real security.";

export function SandboxBanner() {
  return (
    <Alert
      role="note"
      aria-label="Sandbox notice"
      className="rounded-none border-x-0 border-t-0 bg-muted px-4 py-2 text-muted-foreground"
    >
      <FlaskConical aria-hidden="true" />
      <AlertDescription className="text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">{SANDBOX_NOTICE}</span>{" "}
          NatureX is a hackathon prototype. Prices, shares and payouts are
          simulated.
        </p>
      </AlertDescription>
    </Alert>
  );
}
