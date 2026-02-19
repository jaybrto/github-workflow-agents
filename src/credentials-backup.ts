#!/usr/bin/env bun
import { backupCredentials } from "./lib/credentials-manager.js";

async function main() {
  console.log("[CredentialBackup] Starting credential backup to MinIO...");
  await backupCredentials();
  console.log("[CredentialBackup] Done");
  process.exit(0);
}

main().catch((e) => {
  console.error("[CredentialBackup] Fatal error:", e);
  process.exit(1);
});
