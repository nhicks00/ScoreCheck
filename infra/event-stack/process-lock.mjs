import { open, readFile, rm } from "node:fs/promises";

export async function withProcessLock({ lockPath, label }, operation) {
  const handle = await acquireProcessLock(lockPath, label);
  try {
    return await operation();
  } finally {
    try { await handle.close(); }
    finally { await rm(lockPath, { force: true }); }
  }
}

async function acquireProcessLock(lockPath, label) {
  const reclaimPath = `${lockPath}.reclaim`;
  await clearDeadReclaimer(reclaimPath, label);
  try {
    return await createLock(lockPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const reclaimHandle = await acquireReclaimer(reclaimPath, label);
  try {
    const owner = await readOwner(lockPath, label);
    if (owner !== null && processAlive(owner.pid)) throw new Error(`${label} lock already exists: ${lockPath}`);
    await rm(lockPath, { force: true });
    return await createLock(lockPath);
  } finally {
    try { await reclaimHandle.close(); }
    finally { await rm(reclaimPath, { force: true }); }
  }
}

async function acquireReclaimer(path, label) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await createLock(path); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readOwner(path, `${label} reclamation`);
      if (owner !== null && processAlive(owner.pid)) throw new Error(`${label} lock reclamation is already active: ${path}`);
      await rm(path, { force: true });
    }
  }
  throw new Error(`${label} lock reclamation could not acquire ${path}`);
}

async function clearDeadReclaimer(path, label) {
  const owner = await readOwner(path, `${label} reclamation`);
  if (owner === null) return;
  if (processAlive(owner.pid)) throw new Error(`${label} lock reclamation is already active: ${path}`);
  await rm(path, { force: true });
}

async function createLock(path) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
    return handle;
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
}

async function readOwner(path, label) {
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${label} lock metadata is unreadable: ${path}`);
  }
  if (!Number.isInteger(value?.pid) || value.pid <= 0 || typeof value?.acquiredAt !== "string" || !Number.isFinite(Date.parse(value.acquiredAt))) {
    throw new Error(`${label} lock metadata is invalid: ${path}`);
  }
  return value;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}
