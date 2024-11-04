import type { API } from 'homebridge';

import { PLATFORM_NAME } from './settings.js';
import { SternetSmartHomebridgePlatform } from './platform.js';

/**
 * This method registers the platform with Homebridge
 */
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, SternetSmartHomebridgePlatform);
};
