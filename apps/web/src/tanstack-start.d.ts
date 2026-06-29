import type { createStart } from "@tanstack/react-start";

import type { getRouter } from "./router";

type StartFactory = typeof createStart;

declare module "@tanstack/react-start" {
  interface Register {
    ssr: true;
    router: Awaited<ReturnType<typeof getRouter>>;
    start?: ReturnType<StartFactory>;
  }
}
