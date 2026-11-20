// Face detector worker: runs the detector core (detector-core.mjs, MediaPipe tasks) off the UI thread.
// Frames arrive as transferred ImageBitmaps and never leave the browser. The message protocol is documented in
// detector-core.mjs.

import { createDetectorCore } from "/static/detector-core.mjs";

const core = createDetectorCore((message, transfer) => self.postMessage(message, transfer || []));
self.onmessage = (event) => core.handle(event.data);
