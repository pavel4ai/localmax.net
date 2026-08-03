import type { Env } from "./env";

const OWNER = "pavel4ai";
const REPO = "localmax.net";
const BRANCH = "main";
const BATCH_SIZE = 400;
const UA = "localmax-archiver";

/**
 * Hourly batch archive of accepted results into Git.
 *
 * Git is the canonical, auditable record, but it is deliberately not in the write path: a
 * pull request per submission cannot absorb thousands of concurrent contributors, and it
 * would make publication latency unbounded during a spike. Instead every result newly
 * accepted since the last run is written in a single commit through the Git Data API, so
 * one commit costs a handful of API calls regardless of how many results it carries.
 *
 * D1 is fully rebuildable from what this writes. If the archive falls behind, nothing is
 * lost; it simply catches up on the next tick.
 */
export async function runArchive(env: Env): Promise<{ archived: number; commit?: string }> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_INSTALLATION_ID) {
    console.log("archive skipped: GitHub App is not configured");
    return { archived: 0 };
  }

  const pending = await env.DB.prepare(
    `SELECT run_id, profile_id, profile_version, gpu_key, manifest_json
       FROM results
      WHERE archived_at IS NULL AND verification IN ('verified', 'community', 'flagged')
      ORDER BY accepted_at ASC
      LIMIT ${BATCH_SIZE}`,
  ).all<{
    run_id: string;
    profile_id: string;
    profile_version: string;
    gpu_key: string;
    manifest_json: string;
  }>();

  if (pending.results.length === 0) return { archived: 0 };

  const token = await installationToken(env);
  const api = githubClient(token);

  const ref = await api<{ object: { sha: string } }>(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const head = ref.object.sha;
  const headCommit = await api<{ tree: { sha: string } }>(`/repos/${OWNER}/${REPO}/git/commits/${head}`);

  const tree: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (const row of pending.results) {
    const blob = await api<{ sha: string }>(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({
        content: JSON.stringify(JSON.parse(row.manifest_json), null, 2) + "\n",
        encoding: "utf-8",
      }),
    });
    tree.push({
      path: `results/${row.profile_id}/${row.profile_version}/${row.gpu_key}/${row.run_id}.json`,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  const newTree = await api<{ sha: string }>(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }),
  });

  const commit = await api<{ sha: string }>(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message:
        `archive: ${pending.results.length} accepted result(s)\n\n` +
        `Automated hourly archive from the live store. Each file is an accepted result\n` +
        `manifest exactly as submitted; nothing here is edited after the fact.\n`,
      tree: newTree.sha,
      parents: [head],
    }),
  });

  await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  const now = new Date().toISOString();
  await env.DB.batch(
    pending.results.map((r) =>
      env.DB.prepare(`UPDATE results SET archived_at = ?2 WHERE run_id = ?1`).bind(r.run_id, now),
    ),
  );

  return { archived: pending.results.length, commit: commit.sha };
}

/** Delete evidence for submissions that were abandoned or rejected more than 7 days ago. */
export async function runEvidenceCleanup(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();

  const stale = await env.DB.prepare(
    `SELECT run_id, manifest_json FROM submissions
      WHERE updated_at < ?1 AND state IN ('awaiting_upload', 'rejected')
      LIMIT 200`,
  ).bind(cutoff).all<{ run_id: string; manifest_json: string }>();

  let removed = 0;
  for (const row of stale.results) {
    const manifest = JSON.parse(row.manifest_json) as { artifacts?: Array<{ hash: string }> };
    for (const artifact of manifest.artifacts ?? []) {
      const ref = await env.DB.prepare(
        `SELECT refcount FROM artifacts WHERE hash = ?1`,
      ).bind(artifact.hash).first<{ refcount: number }>();
      if (ref && ref.refcount > 0) continue; // referenced by an accepted result
      const hex = artifact.hash.replace(/^sha256:/, "");
      await env.EVIDENCE.delete(`ev/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`).catch(() => {});
      await env.DB.prepare(`DELETE FROM artifacts WHERE hash = ?1 AND refcount <= 0`)
        .bind(artifact.hash).run();
      removed++;
    }
    await env.DB.prepare(`DELETE FROM submissions WHERE run_id = ?1`).bind(row.run_id).run();
  }
  return removed;
}

// --- GitHub App authentication ---------------------------------------------

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function appJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(
    new TextEncoder().encode(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }),
    ),
  );

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(env.GITHUB_APP_PRIVATE_KEY!),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );

  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

async function installationToken(env: Env): Promise<string> {
  const jwt = await appJwt(env);
  const res = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
      },
    },
  );
  if (!res.ok) throw new Error(`GitHub installation token failed: ${res.status}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

function githubClient(token: string) {
  return async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": UA,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub ${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  };
}
