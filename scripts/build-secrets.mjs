import { readFileSync, writeFileSync } from "node:fs";

const required = [
  "OCI_TENANCY",
  "OCI_USER",
  "OCI_FINGERPRINT",
  "OCI_COMPARTMENT",
  "OCI_SUBNET",
  "OCI_IMAGE",
  "OCI_AVAILABILITY_DOMAIN",
];

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
if (!process.env.OCI_SSH_PUBLIC_KEY_PATH) throw new Error("missing OCI_SSH_PUBLIC_KEY_PATH");

const secrets = Object.fromEntries(required.map((name) => [name, process.env[name]]));
secrets.OCI_PRIVATE_KEY = readFileSync(
  process.env.OCI_PRIVATE_KEY_PATH ?? `${process.env.HOME}/.oci/oci_api_key.pem`,
  "utf8",
);
secrets.OCI_SSH_PUBLIC_KEY = readFileSync(process.env.OCI_SSH_PUBLIC_KEY_PATH, "utf8").trim();

writeFileSync(".secrets.json", JSON.stringify(secrets, null, 2));
console.log(`wrote .secrets.json with ${Object.keys(secrets).length} entries`);
