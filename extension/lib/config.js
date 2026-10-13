// Publisher configuration, set once before building. End users never see any of this.
//
// Chrome signs users in with the "Chrome Extension" OAuth client in manifest.json
// (oauth2.client_id). Browsers without chrome.identity.getAuthToken (Edge, Brave, ...)
// fall back to this "Web application" client, whose authorized redirect URI must be
// https://<extension-id>.chromiumapp.org/
export const WEB_CLIENT_ID = '';
