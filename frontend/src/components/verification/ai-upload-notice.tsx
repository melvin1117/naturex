"use client";

import { Sparkles } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { UPLOAD_NOTICE } from "@/lib/ai-suggestion";
import { useWorld } from "@/lib/hooks";

/**
 * ADR-0006 §5: before uploading, the steward is told whether an AI model on Nebius Token
 * Factory may read the documents, worded for what this world really does (`GET /world`'s
 * `document_ai_check`). Until the world is known it says so conditionally.
 */
export function AiUploadNotice() {
  const { world } = useWorld();
  const mode = world?.document_ai_check ?? "unknown";
  const notice = UPLOAD_NOTICE[mode];
  return (
    <Alert role="note" data-ai-check={mode}>
      <Sparkles aria-hidden="true" />
      <AlertTitle className="line-clamp-none">{notice.title}</AlertTitle>
      <AlertDescription>
        <p>{notice.body}</p>
      </AlertDescription>
    </Alert>
  );
}
