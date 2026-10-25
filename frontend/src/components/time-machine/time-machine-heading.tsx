/** The Time Machine's heading: the same on the page and in its loading skeleton. */
export function TimeMachineHeading() {
  return (
    <>
      <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">
        Time Machine
      </h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Move this sandbox forward a quarter or inject an event, and watch
        ratings, stake prices and alerts respond. Every change is a real
        re-rate, stored and labelled simulated.
      </p>
    </>
  );
}
