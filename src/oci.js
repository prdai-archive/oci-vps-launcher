const encoder = new TextEncoder();

let cachedKey;

function host(env) {
  return `iaas.${env.OCI_REGION}.oraclecloud.com`;
}

function base64(bytes) {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function pemToDer(pem) {
  return fromBase64(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
}

async function signingKey(env) {
  if (cachedKey) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(env.OCI_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return cachedKey;
}

async function sha256Base64(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return base64(new Uint8Array(digest));
}

async function signedRequest(env, method, path, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = [
    ["date", new Date().toUTCString()],
    ["(request-target)", `${method.toLowerCase()} ${path}`],
    ["host", host(env)],
  ];

  if (payload !== undefined) {
    headers.push(["content-type", "application/json"]);
    headers.push(["x-content-sha256", await sha256Base64(payload)]);
  }

  const signingString = headers.map(([name, value]) => `${name}: ${value}`).join("\n");
  const signature = base64(
    new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await signingKey(env), encoder.encode(signingString)),
    ),
  );

  const keyId = `${env.OCI_TENANCY}/${env.OCI_USER}/${env.OCI_FINGERPRINT}`;
  const authorization = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${headers
    .map(([name]) => name)
    .join(" ")}",signature="${signature}"`;

  const requestHeaders = { date: headers[0][1], authorization };
  if (payload !== undefined) {
    requestHeaders["content-type"] = "application/json";
    requestHeaders["x-content-sha256"] = headers.find(([name]) => name === "x-content-sha256")[1];
  }

  const response = await fetch(`https://${host(env)}${path}`, {
    method,
    headers: requestHeaders,
    body: payload,
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

export async function listInstances(env) {
  const path = `/20160918/instances?compartmentId=${encodeURIComponent(env.OCI_COMPARTMENT)}`;
  const response = await signedRequest(env, "GET", path);
  if (response.status >= 300) {
    throw new Error(`list instances failed: ${response.status} ${JSON.stringify(response.data)}`);
  }
  return (response.data ?? []).filter(
    (instance) =>
      instance["display-name"] === env.OCI_DISPLAY_NAME && instance["lifecycle-state"] !== "TERMINATED",
  );
}

export async function launchInstance(env) {
  const body = {
    availabilityDomain: env.OCI_AVAILABILITY_DOMAIN,
    compartmentId: env.OCI_COMPARTMENT,
    shape: env.OCI_SHAPE,
    shapeConfig: {
      ocpus: Number(env.OCI_OCPUS),
      memoryInGBs: Number(env.OCI_MEMORY_GBS),
    },
    displayName: env.OCI_DISPLAY_NAME,
    imageId: env.OCI_IMAGE,
    sourceDetails: {
      sourceType: "image",
      imageId: env.OCI_IMAGE,
      bootVolumeSizeInGBs: Number(env.OCI_BOOT_GBS),
    },
    createVnicDetails: {
      subnetId: env.OCI_SUBNET,
      assignPublicIp: true,
      hostnameLabel: env.OCI_DISPLAY_NAME,
    },
    metadata: {
      ssh_authorized_keys: env.OCI_SSH_PUBLIC_KEY,
    },
  };
  return signedRequest(env, "POST", "/20160918/instances", body);
}
