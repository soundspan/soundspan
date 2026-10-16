/**
 * Preloaded by the component test lanes (see `test:component` in package.json).
 *
 * happy-dom rejects a cancelled animation's `finished` promise without marking
 * it handled, while browsers mark it handled per the Web Animations spec. Any
 * framer-motion transition cancelled during unmount then surfaces as an
 * unhandled `AbortError` that fails whichever test happens to be running.
 * Component tests assert rendering and behavior, not motion, so animations are
 * skipped for the whole lane.
 */
import { MotionGlobalConfig } from "framer-motion";

MotionGlobalConfig.skipAnimations = true;
