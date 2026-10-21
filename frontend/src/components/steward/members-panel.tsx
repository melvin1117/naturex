"use client";

import { TriangleAlertIcon, UserMinus } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { LoadError } from "@/components/proto/load-error";
import { StewardPanel } from "@/components/steward/panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
    <StewardPanel title="Members">
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
                  <ConfirmRemove
                    name={member.name}
                    pending={remove.isPending}
                    onConfirm={() => remove.mutate(member.user_id)}
                  />
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
    </StewardPanel>
  );
}

function ConfirmRemove({
  name,
  pending,
  onConfirm,
}: {
  name: string;
  pending: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Remove ${name}`}
          disabled={pending}
        >
          <UserMinus aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {name}?</DialogTitle>
          <DialogDescription>
            They&apos;ll no longer manage this community&apos;s sites. You can
            add them again with their account ID.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              setOpen(false);
              void onConfirm();
            }}
          >
            Remove steward
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddSteward({ communityId }: { communityId: string }) {
  const id = useId();
  const add = useAddSteward(communityId);
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdded(null);
    const value = userId.trim();
    if (!UUID.test(value)) {
      setError("Enter the account ID they shared with you.");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    try {
      const member = await add.mutateAsync(value);
      setUserId("");
      setAdded(`${member.name} is now a steward.`);
    } catch (failure) {
      setError(memberFailure(toApiError(failure)));
      inputRef.current?.focus();
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
          ref={inputRef}
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
        <p
          id={`${id}-hint`}
          aria-live="polite"
          className="text-xs text-muted-foreground"
        >
          {added ??
            "Stewards can list land and manage listings. Members can't trade their community's units."}
        </p>
      )}
    </form>
  );
}
