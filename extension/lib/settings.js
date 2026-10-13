export const QUALITY = {
  '720p30': { label: '720p · 30 fps (~1.1 GB/hour)', width: 1280, height: 720, frameRate: 30, videoBitsPerSecond: 2_500_000 },
  '1080p30': { label: '1080p · 30 fps (~2.2 GB/hour)', width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 5_000_000 },
  '1080p60': { label: '1080p · 60 fps (~3.6 GB/hour)', width: 1920, height: 1080, frameRate: 60, videoBitsPerSecond: 8_000_000 },
};

export const DESTINATIONS = {
  drive: 'Google Drive',
  local: 'This computer',
};

export const DEFAULTS = {
  destination: 'drive',
  quality: '720p30',
  partMinutes: 0, // 0 = one file for the whole recording
  autoStop: false, // keep recording until the user presses Stop
  folderName: 'LiveKeep Recordings',
};

export async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  if (!QUALITY[settings.quality]) settings.quality = DEFAULTS.quality;
  if (!DESTINATIONS[settings.destination]) settings.destination = DEFAULTS.destination;
  return settings;
}
