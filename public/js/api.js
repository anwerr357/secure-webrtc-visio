// REST calls to our server: login/register and the ICE server list.

async function request(path, { token, body } = {}) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const login = (username, password) =>
  request("/api/login", { body: { username, password } });

export const register = (username, password) =>
  request("/api/register", { body: { username, password } });

// STUN + TURN servers. TURN credentials are generated per user and expire,
// which is why we fetch them from the server instead of hardcoding them.
export const getIceServers = (token) =>
  request("/api/ice", { token }).then((d) => d.iceServers);
