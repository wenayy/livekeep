// Google sign-in for the service worker. Chrome uses its built-in account flow
// (tokens refresh automatically); other Chromium browsers use a web sign-in window.

import { WEB_CLIENT_ID } from './config.js';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const NOT_SIGNED_IN = 'Not signed in to Google';

let useWebFlow = false;

const unsupported = (e) => /not supported|unsupported|not available|not implemented/i.test(e?.message ?? '');

export function isConfigured() {
  const chromeClient = chrome.runtime.getManifest().oauth2?.client_id ?? '';
  return !chromeClient.startsWith('YOUR_') || !!WEB_CLIENT_ID;
}

async function chromeToken(interactive) {
  try {
    const { token } = await chrome.identity.getAuthToken({ interactive });
    if (token) return token;
  } catch (e) {
    if (unsupported(e)) throw e;
    if (interactive) throw new Error(/did not approve|canceled|cancelled/i.test(e.message) ? 'Sign-in was cancelled' : e.message);
  }
  throw new Error(NOT_SIGNED_IN);
}

async function webToken(interactive) {
  if (!WEB_CLIENT_ID) throw new Error('Google sign-in is not available in this browser. Choose “This computer” instead.');
  const { webToken: cached } = await chrome.storage.session.get('webToken');
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const { account } = await chrome.storage.local.get('account');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: WEB_CLIENT_ID,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPES.join(' '),
    prompt: interactive ? 'select_account' : 'none',
    ...(account?.email ? { login_hint: account.email } : {}),
  });
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive });
  } catch (e) {
    throw new Error(interactive ? 'Sign-in was cancelled' : NOT_SIGNED_IN);
  }
  const params = new URLSearchParams(new URL(redirect).hash.slice(1));
  const token = params.get('access_token');
  if (!token) throw new Error(interactive ? `Sign-in failed (${params.get('error') ?? 'unknown'})` : NOT_SIGNED_IN);
  const expiresAt = Date.now() + Number(params.get('expires_in') ?? 3600) * 1000;
  await chrome.storage.session.set({ webToken: { token, expiresAt } });
  return token;
}

// `stale` is a token Google just rejected; it is dropped before asking again.
export async function getToken({ interactive = false, stale } = {}) {
  if (stale) await forget(stale);
  if (!useWebFlow) {
    try {
      return await chromeToken(interactive);
    } catch (e) {
      if (!unsupported(e)) throw e;
      useWebFlow = true;
    }
  }
  return webToken(interactive);
}

async function forget(token) {
  if (useWebFlow) await chrome.storage.session.remove('webToken');
  else await chrome.identity.removeCachedAuthToken({ token }).catch(() => {});
}

export async function signOut() {
  const token = await getToken().catch(() => null);
  if (token) {
    // Revoking removes LiveKeep's access entirely, so the next sign-in asks again.
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    }).catch(() => {});
    await forget(token);
  }
  await chrome.identity.clearAllCachedAuthTokens?.().catch(() => {});
  await chrome.storage.session.remove('webToken');
}
