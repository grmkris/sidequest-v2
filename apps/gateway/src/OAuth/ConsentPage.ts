import type { PendingRequest } from '@sidequest/serving/OAuthRequests'
import { redirectShown } from '@sidequest/serving/RedirectUris'

// The gateway's consent page: server-rendered HTML with no framework. Its one script asks the operator's NIP-07
// extension for their public key, lists the agents they keep here with an active grant, and has the extension sign a
// NIP-98 authorization of the one request that allows the chosen agent. The page's text is English, like the core's
// OAuth answers (`x18n.config.ts`); the website's own agent pages, which come later, are translated.

/** The page's content security policy: nothing but its own nonce-bearing script and style, and calls to itself. */
export const consentPolicy = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ')

const escaped = (text: string) => text.replace(/[&<>"']/gu, (character) => `&#${character.codePointAt(0) ?? 0};`)

const style = `body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
button{font:inherit;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0;cursor:pointer}
li{margin:.5rem 0}.note{color:#555;font-size:.9rem}.problem{color:#a00}`

/**
 * The script: `window.nostr` (NIP-07) gives the public key, `GET agents?operator=` lists the agents, and allowing one
 * signs a kind-27235 event naming this page's `allow` URL, the method and the SHA-256 of the body, as NIP-98 asks.
 */
const script = `(() => {
  const page = document.getElementById('consent');
  const base = location.origin + location.pathname;
  const status = document.getElementById('status');
  const list = document.getElementById('agents');
  const say = (text, problem) => { status.textContent = text; status.className = problem ? 'problem' : 'note'; };
  const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  const nip98 = async (url, method, body) => {
    const payload = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    const event = await window.nostr.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: '',
      tags: [['u', url], ['method', method], ['payload', payload]] });
    return 'Nostr ' + btoa(JSON.stringify(event));
  };
  const allow = async (agent) => {
    const body = JSON.stringify({ agent });
    const url = base + '/allow';
    say('Waiting for your signer...');
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',
      authorization: await nip98(url, 'POST', body) }, body });
    const answer = await response.json();
    if (!response.ok) return say('Not allowed: ' + (answer.reason || answer.error), true);
    location.assign(answer.redirect);
  };
  document.getElementById('connect').addEventListener('click', async () => {
    if (!window.nostr) return say('No Nostr signer found. Install a NIP-07 extension and reload.', true);
    const operator = await window.nostr.getPublicKey();
    const response = await fetch(base + '/agents?operator=' + operator);
    const answer = await response.json();
    if (!response.ok) return say('This request is no longer waiting. Start again from the app.', true);
    list.replaceChildren();
    if (answer.items.length === 0) return say('None of your agents here has an active grant.', true);
    say('Pick the agent this app acts as.');
    for (const item of answer.items) {
      const button = document.createElement('button');
      button.textContent = item.label + ' (' + item.scopes.join(', ') + ')';
      button.addEventListener('click', () => allow(item.agent).catch((e) => say(String(e), true)));
      const entry = document.createElement('li');
      entry.append(button);
      list.append(entry);
    }
  });
  document.getElementById('refuse').addEventListener('click', async () => {
    const response = await fetch(base + '/refuse', { method: 'POST' });
    const answer = await response.json();
    if (response.ok) location.assign(answer.redirect); else say('This request is no longer waiting.', true);
  });
  page.hidden = false;
})();`

/** The consent page for a pending request: who asks, where the access goes, and what the operator decides. */
export const consentPage = (pending: PendingRequest, nonce: string) => {
  const redirect = redirectShown(pending.redirectUri)
  const client =
    pending.clientKind === 'published'
      ? `${escaped(pending.clientName ?? 'An app')}, published by ${escaped(new URL(pending.clientId).host)}`
      : `${escaped(pending.clientName ?? 'An app')} (a name the app gave itself, which proves nothing)`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect an agent</title>
<style nonce="${nonce}">${style}</style></head><body>
<h1>Connect an app to one of your agents</h1>
<p>${client} asks to act as one of your Sidequest agents.</p>
<p>Access goes to <strong>${escaped(redirect.host)}</strong>${redirect.loopback ? ' on this device' : ''}.</p>
<p class="note">The app acts only within the grant you signed for the agent. It never pays: funding the escrow is
your wallet's alone. Rooms the agent joins are readable by this gateway.</p>
<div id="consent" hidden>
<button id="connect" type="button">Prove your key and pick an agent</button>
<button id="refuse" type="button">Refuse</button>
<p id="status" class="note"></p><ul id="agents"></ul></div>
<noscript><p class="problem">Consent needs JavaScript and a Nostr signer extension.</p></noscript>
<script nonce="${nonce}">${script}</script></body></html>`
}

/** The page for a request that is not waiting in this browser: decided, expired, or opened elsewhere. */
export const gonePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Request gone</title></head>
<body><p>This connection request is no longer waiting. Start again from the app you are connecting.</p></body></html>`
