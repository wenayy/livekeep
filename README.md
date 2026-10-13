# LiveKeep

A Chrome extension that records the YouTube livestream you're watching (just the video, full frame) and saves it **while it records**, either to your Google Drive or to your computer. If the creator deletes the stream or makes it private, everything up to that moment is already saved.

## For users

1. Install LiveKeep from the Chrome Web Store.
2. Click the LiveKeep icon and pick where recordings go:
   - **Google Drive:** click **Sign in with Google** once. Video uploads as it records, so it's safe even if your computer dies. LiveKeep can only see the recordings it saves, nothing else in your Drive.
   - **This computer:** no account needed. Files go to `Downloads/LiveKeep Recordings/`.
3. Open a YouTube live stream, click the icon, then **Record this stream**. Keep watching as normal.

**Watch list (record without watching):**
- Paste a channel link (`@LofiGirl` or `youtube.com/@LofiGirl`) or a scheduled stream's link into **Watch list** in the popup. On a YouTube page you can also click **+ Watch this channel**.
- LiveKeep checks every 1–2 minutes from your own browser (every 10 minutes when a scheduled stream is more than an hour away).
- When the channel goes live, LiveKeep:
  1. opens the stream in a small muted window and minimizes it;
  2. records it to the destination you picked, skipping any ads;
  3. stops when the stream ends (or goes private) and closes the window.
- Chrome must be open and the computer awake. With **Google Drive** as the destination, the recording shows up in the Drive app on your phone.
- Whatever aired before LiveKeep noticed the stream isn't recorded, so add the channel before it goes live.

What happens next:
- **Files:** one MP4 per recording, in a folder named `<date> · <channel> · <title>`.
  - **Google Drive:** the video uploads continuously while recording, and the file appears in Drive when you press Stop.
  - **This computer:** the recording is held safely on disk inside Chrome while it records, and lands in Downloads when you press Stop.
  - To get a new file every N minutes instead, change **Files** in Settings.
- **Only the video:** the recording is cropped to the video player, filling the whole frame, with no YouTube page, chat or sidebar. Keep the video on screen. If you scroll it out of view, that stretch is recorded as black. YouTube's controls appear in the recording while your mouse is over the video.
- **Keeps going until you stop:** if the stream ends or goes private, LiveKeep keeps recording and shows YouTube's message in the popup. Everything recorded so far is already saved. Closing the tab ends the recording. To have it stop by itself instead, turn on **Stop automatically** in Settings.
- **Badge:** the icon shows a red **REC** while recording and a blue **↑** while it finishes saving.
- **Crashes:** if Chrome crashes, recorded data waits on your computer and finishes saving the next time Chrome starts.
- **Sound:** use **Mute for me** instead of muting YouTube. It silences your speakers but keeps the sound in the recording.

## Publisher setup (once, before you publish; users never see this)

Users sign in with *your* app's Google sign-in. You set it up once:

1. **Get the store's extension ID.** Run `npm run zip` and upload `livekeep.zip` to the Chrome Web Store developer dashboard as a draft.
   1. In the item's **Package** tab, click **View public key** and paste it into `"key"` in `extension/manifest.json`.
   2. Reload the unpacked extension. Its ID now matches the store's.
2. **Set up Google Cloud** in your project:
   1. Enable the **Google Drive API**.
   2. Configure the OAuth consent screen: External, with the scope `.../auth/drive.file`. This scope only gives access to files the app creates and is Google's recommended low-risk Drive scope.
   3. Create an OAuth client ID of type **Chrome Extension** with *Item ID* set to your store ID.
   4. Put its client ID in `extension/manifest.json` → `oauth2.client_id`.
3. **Optional: Edge, Brave and other Chromium browsers.** These don't support Chrome's built-in sign-in.
   1. Create a second OAuth client of type **Web application**.
   2. Set its authorized redirect URI to `https://<extension-id>.chromiumapp.org/`.
   3. Put its client ID in `extension/lib/config.js` → `WEB_CLIENT_ID`.
   4. Without this, users in those browsers can still choose **This computer**.
4. **Before going public:** publish the consent screen and complete Google's brand verification. While it's in *Testing*, only listed test users (up to 100) can sign in, and they're asked to sign in again about every 7 days.

## How it works

```
YouTube tab ──tabCapture──▶ offscreen document
                             ├─ plays the audio back to you
                             ├─ MediaRecorder (H.264/AAC MP4, 1 s chunks; new recorder per part)
                             └─ chunks ──▶ IndexedDB ──uploader──▶ Drive resumable upload (one per part)
                                                               └─▶ Downloads/LiveKeep Recordings/… (one file per part)
watch list: alarm ─▶ fetch the channel's /live page ─▶ live? ─▶ open stream in a muted, minimized window
            autorec.js in that tab: video.captureStream() ─▶ cropper ─▶ MediaRecorder ─▶ chunks ─▶ offscreen ─▶ same IndexedDB + uploader
content script ── where the video is on screen ──▶ cropper (only the video, fixed 16:9 output)
               ── "stream is gone / ended" ──▶ service worker ──▶ notice (or stop, if enabled)
```

- `extension/background.js`: service worker. Handles start/stop, Drive folders or Downloads paths, tab watching, the badge and resuming after a restart.
- `extension/lib/auth.js`: Google sign-in. Uses Chrome's built-in account flow, falling back to a web sign-in window in other Chromium browsers.
- `extension/lib/cropper.js`: crops each captured frame to the video's on-screen rectangle and scales it into a fixed-size letterboxed frame. It accounts for the black padding Chrome adds around captured tabs.
- `extension/offscreen.js`: capture, audio passthrough, part rotation (the next part starts before the previous one stops, so there are no gaps) and the upload loop.
- `extension/lib/uploader.js`: drains IndexedDB to the chosen destination.
  - **Drive:** resumable uploads, sent in 256 KiB multiples while recording, resent from wherever Drive says it stopped, and finalized once a part is closed.
  - **This computer:** each finished part is written once through `chrome.downloads`.
- `extension/lib/youtube.js`: understands pasted links and reads a page's live, scheduled or ended status from YouTube's own player data.
- `extension/autorec.js`: records a watch-list stream inside its tab. Chrome only allows tab capture after a click, so it records the player's own stream instead. It plays the video unmuted while the tab itself is muted: Chrome pauses muted videos in hidden tabs, but this way the recording keeps its sound and you hear nothing. It pauses recording during ads, presses Skip and "Continue watching?", and starts a new part if YouTube swaps the video source.
- `extension/content.js`: while recording, reports where the video sits on screen (including the miniplayer). It also watches for the "unavailable / private / removed" screens and for the stream ending. It never draws anything, because anything on the page would end up in the recording.

## Development

```sh
npm install
npm test        # uploader tests against a fake Drive that enforces the resumable-upload rules
npm run zip     # package extension/ into livekeep.zip
```

`extension-key.pem` is the private key behind the fixed extension ID. Keep it private, and out of git (it's in `.gitignore`).

## Known limitations

- A file appears in Drive or Downloads when its recording (or part) finishes. Until then:
  - **This computer:** the data is held in Chrome's on-disk storage. That survives crashes, but not a dead disk.
  - **Google Drive:** the data is already on Google's servers, and gets finalized even after a crash, as long as Chrome is reopened within about a week.
- MediaRecorder files don't declare a total duration. Drive's player, VLC and QuickTime play them fine, but a few players show the duration only after scanning the file.
- Desktop Chromium browsers only (Chrome 116+). In browsers without Chrome's built-in sign-in, Google Drive needs the optional web client from Publisher setup step 3. Saving to this computer works everywhere.
