/**
 * The feature registry.
 *
 * To add a feature: create src/features/<name>/index.ts exporting a `Feature`,
 * then add it to this array. That's the whole wiring step — commands, buttons,
 * events, startup jobs and shutdown all get handled by the runtime.
 */

import type { Feature } from '../lib/types.js';
import { verificationFeature } from './verification/index.js';

export const features: Feature[] = [verificationFeature];
