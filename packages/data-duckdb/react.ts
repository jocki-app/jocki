import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
} from "react";
import { subscribeOptimistic } from "../ui/optimistic";
import { notify } from "../ui/notifications";
import { DatabaseClosedError } from "../storage/database";
import { subscribeStorage } from "./cache";
import { coalescedRefresh } from "./refresh";
import { shareQueryResult } from "./query-result";
export function useLiveQuery<T>(
  query: () => Promise<T> | T,
  dependencies: DependencyList = [],
  defaultValue?: T,
): T | undefined {
  const latest = useRef(query);
  latest.current = query;
  const identity = useMemo(() => ({}), dependencies);
  const [state, setState] = useState<{
    identity: object;
    value: T | undefined;
  }>({
    identity,
    value: defaultValue,
  });
  useEffect(() => {
    setState({ identity, value: defaultValue });
    let alive = true;
    const refresh = coalescedRefresh(
      async () => {
        const value = await latest.current();
        if (alive)
          setState((previous) => {
            const next = shareQueryResult(
              previous.identity === identity ? previous.value : defaultValue,
              value,
            );
            return previous.identity === identity &&
              Object.is(previous.value, next)
              ? previous
              : { identity, value: next };
          });
      },
      (error) => {
        if (alive && !(error instanceof DatabaseClosedError))
          notify.error(error);
      },
    );
    const storage = subscribeStorage(refresh),
      optimistic = subscribeOptimistic(refresh);
    refresh();
    return () => {
      alive = false;
      refresh.stop();
      storage();
      optimistic();
    };
  }, dependencies);
  return state.identity === identity ? state.value : defaultValue;
}
