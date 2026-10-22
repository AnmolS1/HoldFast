// A route's page as its own chunk: the module is imported the first time the page RENDERS, not
// when the route tree is built, so it stays out of the main bundle (the bundle budget,
// scripts/lhci/budgets.ts). A component in the route's element rather than react-router's route
// `lazy`: the frame renders a cold overlay's background through `useRoutes`, which never resolves
// a route's `lazy`; and an element renders only after every guard above it has passed (the admin
// console is never fetched for a non-admin).
import { Suspense, use, type ComponentType, type ReactElement } from "react";

export type LazyPage = (() => ReactElement) & {
  /** Import the page now. Once it has loaded, the page renders without suspending. */
  preload(): Promise<void>;
};

/** A component that loads `name` from `load()` on first render; nothing is shown meanwhile. */
export function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): LazyPage {
  let Loaded: ComponentType | null = null;
  let loading: Promise<void> | null = null;
  const preload = (): Promise<void> =>
    (loading ??= load().then(
      (module) => {
        Loaded = module[name];
      },
      (error: unknown) => {
        // A chunk that failed to load (a dropped connection, a new deploy) is imported again on
        // the next render (whether the browser refetches it is the browser's choice); the error
        // goes to the route's error boundary meanwhile.
        loading = null;
        throw error;
      },
    ));

  function Page() {
    if (!Loaded) use(preload());
    const Component = Loaded!;
    return <Component />;
  }

  function LazyRoutePage() {
    return (
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    );
  }
  return Object.assign(LazyRoutePage, { preload });
}
