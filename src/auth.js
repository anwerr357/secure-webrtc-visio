// Authentication: user accounts, password hashing and JWT tokens.
//
// Passwords are never stored: we keep a random salt and the scrypt hash of
// (salt + password). scrypt is deliberately slow, which makes brute-forcing a
// stolen users.json expensive. It ships with Node, so no extra dependency.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import jwt from "jsonwebtoken";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD = 8;
const TOKEN_TTL = "2h";

export function createAuth({ jwtSecret, usersFile }) {
  const users = loadUsers(usersFile);

  function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64);
  }

  function register(username, password) {
    if (!USERNAME_RE.test(username ?? "")) {
      throw new AuthError(400, "Username: 3-20 letters, digits or _");
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD) {
      throw new AuthError(400, `Password: at least ${MIN_PASSWORD} characters`);
    }
    if (users[username]) throw new AuthError(409, "Username already taken");

    const salt = crypto.randomBytes(16);
    users[username] = {
      salt: salt.toString("hex"),
      hash: hashPassword(password, salt).toString("hex"),
    };
    saveUsers(usersFile, users);
  }

  function login(username, password) {
    const record = users[username];
    // Same error for "unknown user" and "wrong password" so an attacker
    // cannot use the login form to discover which usernames exist.
    const fail = new AuthError(401, "Invalid username or password");
    if (!record || typeof password !== "string") throw fail;

    const expected = Buffer.from(record.hash, "hex");
    const actual = hashPassword(password, Buffer.from(record.salt, "hex"));
    // timingSafeEqual takes the same time whatever the content, so response
    // time leaks nothing about how many bytes matched.
    if (!crypto.timingSafeEqual(expected, actual)) throw fail;

    return jwt.sign({ sub: username }, jwtSecret, { expiresIn: TOKEN_TTL });
  }

  // Returns the username, or null if the token is missing, forged or expired.
  function verifyToken(token) {
    try {
      return jwt.verify(token, jwtSecret, { algorithms: ["HS256"] }).sub;
    } catch {
      return null;
    }
  }

  // Express middleware for routes that need a logged-in user.
  function requireAuth(req, res, next) {
    const header = req.get("authorization") ?? "";
    const user = verifyToken(header.replace(/^Bearer /, ""));
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    req.user = user;
    next();
  }

  const router = express.Router();
  const limiter = rateLimit({ max: 10, windowMs: 60_000 });

  router.post("/register", limiter, (req, res) => {
    const { username, password } = req.body ?? {};
    try {
      register(username, password);
      res.status(201).json({ token: login(username, password), user: username });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/login", limiter, (req, res) => {
    const { username, password } = req.body ?? {};
    try {
      res.json({ token: login(username, password), user: username });
    } catch (err) {
      sendError(res, err);
    }
  });

  return { router, requireAuth, verifyToken };
}

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendError(res, err) {
  if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Server error" });
}

// Fixed-window limiter per IP: slows down password guessing on the auth routes.
function rateLimit({ max, windowMs }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip);
    if (!entry || now > entry.reset) {
      hits.set(req.ip, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++entry.count > max) {
      return res.status(429).json({ error: "Too many attempts, try again later" });
    }
    next();
  };
}

function loadUsers(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveUsers(file, users) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(users, null, 2), { mode: 0o600 });
}
