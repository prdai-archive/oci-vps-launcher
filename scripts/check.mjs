import { readFileSync } from "node:fs";
import { listInstances } from "../src/oci.js";

const env = {
  ...process.env,
  OCI_PRIVATE_KEY: readFileSync(
    process.env.OCI_PRIVATE_KEY_PATH ?? `${process.env.HOME}/.oci/oci_api_key.pem`,
    "utf8",
  ),
};

const instances = await listInstances(env);
console.log(`signed request ok, matching instances: ${instances.length}`);
