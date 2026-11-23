/** Invalidation is a request to read the latest state, not another unit of work.
 * Collapse a burst into one read, and retain one follow-up if state changes while
 * that read is in flight. This also bounds the lifetime of stale async closures.
 */
export function coalescedRefresh(
  work: () => Promise<void>,
  failed: (error: unknown) => void,
) {
  let dirty = false,
    running = false,
    stopped = false;
  let idle = Promise.resolve(),
    complete = () => {};
  const run = async () => {
    try {
      while (dirty && !stopped) {
        dirty = false;
        try {
          await work();
        } catch (error) {
          if (!stopped) failed(error);
        }
      }
    } finally {
      running = false;
      complete();
    }
  };
  const refresh = () => {
    if (stopped) return;
    dirty = true;
    if (running) return;
    running = true;
    idle = new Promise<void>((resolve) => {
      complete = resolve;
    });
    queueMicrotask(() => void run());
  };
  refresh.stop = () => {
    stopped = true;
    dirty = false;
  };
  refresh.idle = () => idle;
  return refresh;
}
