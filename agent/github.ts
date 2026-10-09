import { createSign } from "node:crypto";
import { env } from "node:process";

import type { GitIdentity } from "./workspace/index.js";

const API = "https://api.github.com";

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

function appJwt(appId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

async function github(path: string, jwt: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok)
    throw new Error(
      `GitHub ${path}: HTTP ${response.status} ${await response.text()}`,
    );
  return response.json();
}

function appCredentials() {
  const appId = env.GITHUB_APP_ID;
  const key = env.GITHUB_APP_PRIVATE_KEY;
  // A PEM, with real or escaped newlines, or the PEM base64-encoded.
  const privateKey = key?.startsWith("-----")
    ? key.replaceAll("\\n", "\n")
    : key && Buffer.from(key, "base64").toString();
  if (!appId || !privateKey)
    throw new Error(
      "set GITHUB_TOKEN, or GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY",
    );
  return appJwt(appId, privateKey);
}

export async function githubToken(repo: string): Promise<string> {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const jwt = appCredentials();
  const installation = await github(`/repos/${repo}/installation`, jwt);
  const { token } = await github(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    {
      method: "POST",
      body: JSON.stringify({ repositories: [repo.split("/")[1]] }),
    },
  );
  return token;
}

let identity: Promise<GitIdentity> | undefined;

// The account the credentials belong to: a GitHub App's bot, or the token's
// user. The noreply address ties commits to that account.
export function gitIdentity(token: string): Promise<GitIdentity> {
  identity ??= (async () => {
    const login = env.GITHUB_TOKEN
      ? (await github("/user", token)).login
      : `${(await github("/app", appCredentials())).slug}[bot]`;
    const user = await github(`/users/${encodeURIComponent(login)}`, token);
    return {
      name: user.name || login,
      email: `${user.id}+${login}@users.noreply.github.com`,
    };
  })().catch((error) => {
    identity = undefined;
    throw error;
  });
  return identity;
}
