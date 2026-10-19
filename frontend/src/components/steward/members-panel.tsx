"use client";

import { TriangleAlertIcon, UserMinus } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { LoadError } from "@/components/proto/load-error";
import { Panel } from "@/components/proto/report-panels";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { toApiError } from "@/lib/api/errors";
import { memberFailure } from "@/lib/community";
import {
  useAddSteward,
  useCommunityMembers,
  useMeId,
  useRemoveMember,
} from "@/lib/community-hooks";
import { COMMUNITY_ROLE_LABEL } from "@/lib/navigation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The owner and stewards (`GET /communities/{id}/members`). With `manage` (the owner), a
 * steward can be added by account ID and removed; the API decides who may join.
 */
export function MembersPanel({
  communityId,
  manage = false,
  footer,
}: {
  communityId: string;
  manage?: boolean;
  footer?: React.ReactNode;
}) {
  const members = useCommunityMembers(communityId);
  const remove = useRemoveMember(communityId);
  const meId = useMeId();

  return (
    <Panel title="Members" aria-label="Members">
      {members.error ? (
        <LoadError
          title="We couldn't load the members"
          error={members.error}
          retry={members.refetch}
        />
      ) : !members.data ? (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner aria-hidden="true" role="presentation" />
          Loading members…
        </p>
      ) : (
        <ul className="space-y-2 text-sm">
          {members.data.map((member) => (
            <li
              key={member.user_id}
              className="flex min-w-0 items-center justify-between gap-3"
            >
              <span className="min-w-0 truncate">
                {member.name}
                {member.user_id === meId && (
                  <span className="text-muted-foreground"> (you)</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Badge variant="secondary">
                  {COMMUNITY_ROLE_LABEL[member.role]}
                </Badge>
                {manage && member.role === "steward" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={`Remove ${member.name}`}
                    disabled={remove.isPending}
                    onClick={() => void remove.mutate(member.user_id)}
                  >
                    <UserMinus aria-hidden="true" />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {remove.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {memberFailure(remove.error)}
        </p>
      )}
      {manage && <AddSteward communityId={communityId} />}
      {footer}
    </Panel>
  );
}

function AddSteward({ communityId }: { communityId: string }) {
  const id = useId();
  const add = useAddSteward(communityId);
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdded(null);
    const value = userId.trim();
    if (!UUID.test(value)) {
      setError("Enter the account ID they shared with you.");
      return;
    }
    setError(null);
    try {
      const member = await add.mutateAsync(value);
      setUserId("");
      setAdded(`${member.name} is now a steward.`);
    } catch (failure) {
      setError(memberFailure(toApiError(failure)));
    }
  }

  return (
    <form
      noValidate
      onSubmit={(e) => void submit(e)}
      className="mt-5 space-y-2 border-t border-border pt-4"
    >
      <Label htmlFor={`${id}-user`}>Add a steward by account ID</Label>
      <div className="flex gap-2">
        <Input
          id={`${id}-user`}
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setError(null);
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder="e.g. 3f2c…"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          className="font-mono text-xs"
        />
        <Button type="submit" variant="outline" disabled={add.isPending}>
          {add.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive" role="alert" id={`${id}-hint`}>
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {added ??
            "Stewards can list land and manage listings. Members can't trade their community's units."}
        </p>
      )}
    </form>
  );
}
