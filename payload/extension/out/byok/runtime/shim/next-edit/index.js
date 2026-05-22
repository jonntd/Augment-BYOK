"use strict";

const nodePath = require("path");

const { state } = require("../../../config/state");
const { normalizeString } = require("../../../infra/util");
const { normalizeBlobsMap, coerceBlobText } = require("../../../core/blob-utils");
const { pickPath } = require("../../../core/next-edit/fields");

const WORKSPACE_BLOB_MAX_CHARS = 2_000_000;

async function readWorkspaceFileTextByPath(p) {
  const raw = normalizeString(p);
  if (!raw) return "";
  const vscode = state.vscode;
  const ws = vscode && vscode.workspace ? vscode.workspace : null;
  const Uri = vscode && vscode.Uri ? vscode.Uri : null;
  if (!ws || !ws.fs || typeof ws.fs.readFile !== "function" || !Uri) return "";

  const isAllowedWorkspaceUri = (uri) => {
    if (!uri) return false;
    try {
      if (ws && typeof ws.getWorkspaceFolder === "function") {
        return Boolean(ws.getWorkspaceFolder(uri));
      }
    } catch {}
    return false;
  };

  const tryRead = async (uri) => {
    try {
      if (!isAllowedWorkspaceUri(uri)) return null;
      const bytes = await ws.fs.readFile(uri);
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return null;
    }
  };

  if (raw.includes("://")) {
    try {
      const txt = await tryRead(Uri.parse(raw));
      if (txt !== null) return txt;
    } catch {}
  }

  try {
    if (nodePath.isAbsolute(raw)) {
      const txt = await tryRead(Uri.file(raw));
      if (txt !== null) return txt;
    }
  } catch {}

  const rel = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const folders = Array.isArray(ws.workspaceFolders) ? ws.workspaceFolders : [];
  for (const f of folders) {
    const base = f && f.uri ? f.uri : null;
    if (!base) continue;
    const u = Uri.joinPath(base, rel);
    const txt = await tryRead(u);
    if (txt !== null) return txt;
  }
  return null;
}

async function maybeAugmentBodyWithWorkspaceBlob(body, { pathHint, blobKey } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const blobs = normalizeBlobsMap(b.blobs);

  const hint = normalizeString(pathHint);
  const path = hint || pickPath(b);
  if (!path) return b;

  const key = normalizeString(blobKey) || path;
  if (blobs && coerceBlobText(blobs[key])) return b;

  const txt = await readWorkspaceFileTextByPath(path);
  if (txt === null) return b;
  if (txt.length > WORKSPACE_BLOB_MAX_CHARS) return b;
  return { ...b, blobs: { ...(blobs || {}), [key]: txt } };
}

module.exports = { maybeAugmentBodyWithWorkspaceBlob };
