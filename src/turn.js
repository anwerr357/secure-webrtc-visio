// ICE server list for the client, with short-lived TURN credentials.
//
// A TURN server relays media, so it costs bandwidth: it must not be open to
// anyone. Instead of a fixed password hardcoded in the client, we use the
// "TURN REST API" scheme that coturn supports (use-auth-secret):
//   username   = "<expiry unix time>:<user>"
//   credential = base64(HMAC-SHA1(shared secret, username))
// coturn recomputes the HMAC with the same secret and rejects expired
// usernames. The secret never leaves the servers, and a leaked credential
// stops working after TTL seconds.
import crypto from "node:crypto";

const TTL_SECONDS = 3600;

export function turnCredentials(user, secret, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + TTL_SECONDS;
  const username = `${expiry}:${user}`;
  const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}

export function iceServersFor(user, { stunUrls, turnUrls, turnSecret }) {
  const servers = [];
  if (stunUrls.length) servers.push({ urls: stunUrls });
  if (turnUrls.length && turnSecret) {
    servers.push({ urls: turnUrls, ...turnCredentials(user, turnSecret) });
  }
  return servers;
}
