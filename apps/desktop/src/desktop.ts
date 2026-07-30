import { tauriDesktop } from "./bridge";
import { e2eDesktop } from "./e2eDesktop";

import type { DesktopPort } from "./desktopPort";

/** Selects the host adapter once; React only sees the shared port. */
export const desktop: DesktopPort = globalThis.__Chronie_E2E__ ? e2eDesktop : tauriDesktop;
