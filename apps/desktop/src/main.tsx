/**
 * Where the window starts.
 *
 * The dashboard and the settings are read before anything is drawn rather than after, and
 * deliberately: they come out of an embedded database on the same machine, they are the whole
 * of what every view reads, and a first paint of empty scaffolding followed a beat later by
 * the real thing is a worse window than one that opens with its contents already in it.
 *
 * There is no `StrictMode` around the app, and that is a decision rather than an oversight.
 * Its double-invocation is a way of finding effects that are not safe to run twice, and three
 * of the ones here are deliberately not: the 3D stage is a graphics context a browser hands
 * out a limited number of, the link handler is a document listener with nothing to remove it,
 * and the dialogs drive an element that throws if it is opened while already open.
 */

import { createRoot } from "react-dom/client";

import { App } from "./app";
import { desktop } from "./bridge";

const root = document.getElementById("root");
if (!root) throw new Error("The window is missing #root.");

const [payload, settings] = await Promise.all([desktop.dashboard(), desktop.settings()]);

createRoot(root).render(<App payload={payload} settings={settings} />);
