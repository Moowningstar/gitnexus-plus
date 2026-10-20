import * as React from 'react';

/**
 * A clock that only ticks while it matters.
 *
 * The panel used to own one `tick` state and pass `now` down, which re-rendered the
 * entire report — activity lists, graph card, search — once a second just to advance a
 * single elapsed-seconds line. Each card that shows elapsed time now owns a clock that
 * only runs while its work is running, and stops when it finishes.
 *
 * `active` must be computed before any early return in the caller: hooks cannot be
 * conditional, and a component that returns null before calling this would break the
 * hook order the first time a run starts.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
