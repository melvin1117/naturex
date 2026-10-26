/**
 * The admin verification area's heading and intro (T70, #211): drawn by the screen and by its
 * loading skeleton (#219), so the two never disagree and the page doesn't jump between them.
 */
export function ReviewQueueHeading() {
  return (
    <>
      <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        Reviews
      </h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Approve an offer to put its site on the Marketplace, or send it back
        with a note.
      </p>
    </>
  );
}
