import { QUALITY, DESTINATIONS, DEFAULTS, loadSettings } from './lib/settings.js';

const destination = document.getElementById('destination');
const quality = document.getElementById('quality');
const partMinutes = document.getElementById('partMinutes');
const folderName = document.getElementById('folderName');
const autoStop = document.getElementById('autoStop');
const saved = document.getElementById('saved');

for (const [value, label] of Object.entries(DESTINATIONS)) {
  destination.append(new Option(label, value));
}
for (const [value, { label }] of Object.entries(QUALITY)) {
  quality.append(new Option(label, value));
}

const settings = await loadSettings();
destination.value = settings.destination;
quality.value = settings.quality;
partMinutes.value = String(settings.partMinutes);
folderName.value = settings.folderName;
autoStop.checked = settings.autoStop;

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    destination: destination.value,
    quality: quality.value,
    partMinutes: Number(partMinutes.value),
    folderName: folderName.value.trim() || DEFAULTS.folderName,
    autoStop: autoStop.checked,
  });
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 1500);
});
