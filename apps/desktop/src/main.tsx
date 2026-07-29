/**
 * Where the window starts.
 *
 * The dashboard and the settings are read before anything is drawn rather than after, and
 * deliberately: they come out of an embedded database on the same machine, they are the whole
 * of what every view reads, and a first paint of empty scaffolding followed a beat later by
 * the real thing is a worse window than one that opens with its contents already in it.
 *
 * `StrictMode` is here, and what it is for is the effects rather than the rendering. In
 * development it sets every effect in the app up, tears it down and sets it up again — so an
 * effect whose cleanup is missing, incomplete or in the wrong order fails loudly on the
 * developer's own machine rather than quietly on somebody's. Three things in this window had to be
 * made honest before it could go back in, and each of them is a thing that would have gone wrong
 * in production sooner or later:
 *
 *  - **The 3D stages.** A graphics context is something a browser hands out about sixteen of,
 *    silently discarding the oldest after that, so one leaked is a picture somewhere else that
 *    stops working for no visible reason. `stage.ts` and `galleryTile.tsx` hold the two of them,
 *    and both now give back a stage that was still being made as surely as one that had arrived,
 *    and refuse to draw on one already given back.
 *  - **The link handler.** `installExternalLinks` answers with the way to stop, and did not: a
 *    listener on the document with nothing to remove it, and two of them is one click on one link
 *    opening two browser tabs.
 *  - **The dialogs.** `showModal` throws on an element that is already open, so `dialog.ts` reads
 *    the element's own `open` rather than a prop, in one place, for all four of them.
 *
 * The rest of it is in `resource.ts` and `book.ts`: what the window goes and asks for, asked once
 * across a teardown rather than twice, and never written to the screen after the thing that wanted
 * it has gone.
 */

// First, and deliberately: every sheet below it is written in the terms this one sets, and a
// module graph that reached a view's stylesheet before this one would have the view overriding
// the page rather than the other way round.
import "./base.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { desktop } from "./desktop";

const root = document.getElementById("root");
if (!root) throw new Error("The window is missing #root.");

const [payload, settings, release] = await Promise.all([
  desktop.dashboard(),
  desktop.settings(),
  // Which build this is, asked for alongside them and forgiven for failing. It is a line in the
  // corner of the app bar, and a window that would not open because it could not name itself
  // would be the worst trade in the app.
  desktop.release().catch(() => null),
]);

createRoot(root).render(
  <StrictMode>
    <App payload={payload} settings={settings} release={release} />
  </StrictMode>,
);
