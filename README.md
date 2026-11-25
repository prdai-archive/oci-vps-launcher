# oci-vps-launcher

A Cloudflare Worker that retries the launch of an Oracle Cloud `VM.Standard.A1.Flex` instance every minute until Always Free capacity appears. It runs on a Cron Trigger, so it keeps trying when your laptop is off.

Oracle's free Ampere A1 pool is scarce in many regions. A launch returns `500 Out of host capacity` most of the time. This Worker turns that into a background loop you do not have to babysit.

## How it works

Each run does two signed OCI calls:

1. List instances in the compartment. If one named `OCI_DISPLAY_NAME` exists, do nothing.
2. Otherwise call `LaunchInstance` with the configured shape, image, subnet, and SSH key.

Requests use OCI's HTTP Signature V1, implemented with Web Crypto (`RSASSA-PKCS1-v1_5`, SHA-256). The imported private key is cached per isolate. A `429 Too many requests` or `500 Out of host capacity` is expected; the next run tries again.

The launch body must use `sourceDetails.imageId`. Sending only `sourceDetails.sourceId` returns `MissingParameter: imageId or instanceSourceImageFilterDetails are invalid`.

## Prerequisites

- An OCI tenancy with Always Free eligibility. Always Free compute is available only in the tenancy home region.
- A VCN with a public subnet and a security list that allows SSH. This Worker launches an instance into an existing subnet; it does not create networking.
- An OCI API key for a user that can manage instances in the compartment.
- A Cloudflare account and `wrangler`.
- Node.js 18 or newer for the helper scripts.

## Collect the OCI values

Console paths:

| Value | Where |
| --- | --- |
| Tenancy OCID | Profile menu > Tenancy > Tenancy Details > OCID |
| User OCID | Profile menu > My profile > User Details > OCID |
| Fingerprint | Profile menu > My profile > API keys |
| Compartment OCID | Identity > Compartments, or the tenancy OCID for the root compartment |
| Availability domain | Compute > Instances > Create instance, or the CLI command below |
| Subnet OCID | Networking > Virtual Cloud Networks > subnet |
| Image OCID | See the CLI command below |

```sh
TENANCY=<tenancy-ocid>
REGION=<region-id>
AD=$(oci iam availability-domain list --compartment-id "$TENANCY" --query 'data[0].name' --raw-output)
oci compute image list --compartment-id "$TENANCY" \
  --operating-system "Canonical Ubuntu" --operating-system-version 22.04 \
  --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output
```

The private key must be PKCS#8. `openssl genrsa` on OpenSSL 3 and the OCI console both produce that format.

## Configure

`wrangler.jsonc` holds non-sensitive values:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OCI_REGION` | `ap-hyderabad-1` | Region identifier |
| `OCI_SHAPE` | `VM.Standard.A1.Flex` | Always Free ARM shape |
| `OCI_OCPUS` | `2` | Always Free allows 2 OCPUs total |
| `OCI_MEMORY_GBS` | `12` | Always Free allows 12 GB total |
| `OCI_BOOT_GBS` | `50` | Boot volume size |
| `OCI_DISPLAY_NAME` | `my-vps` | Instance name and idempotency key |

Secrets are uploaded to Cloudflare and never committed:

| Secret | Value |
| --- | --- |
| `OCI_TENANCY` | Tenancy OCID |
| `OCI_USER` | User OCID |
| `OCI_FINGERPRINT` | API key fingerprint |
| `OCI_COMPARTMENT` | Compartment OCID |
| `OCI_SUBNET` | Subnet OCID |
| `OCI_IMAGE` | Image OCID |
| `OCI_AVAILABILITY_DOMAIN` | Availability domain name |
| `OCI_PRIVATE_KEY` | Private key PEM contents |
| `OCI_SSH_PUBLIC_KEY` | Public key injected into the instance |

Build the secrets file:

```sh
export OCI_TENANCY=...
export OCI_USER=...
export OCI_FINGERPRINT=...
export OCI_COMPARTMENT="$OCI_TENANCY"
export OCI_SUBNET=...
export OCI_IMAGE=...
export OCI_AVAILABILITY_DOMAIN=...
export OCI_SSH_PUBLIC_KEY_PATH="$HOME/.ssh/id_ed25519.pub"
npm run secrets
```

`OCI_PRIVATE_KEY_PATH` defaults to `~/.oci/oci_api_key.pem`.

## Verify signing before deploying

This performs a read-only, signed `ListInstances` call:

```sh
export OCI_REGION=ap-hyderabad-1
export OCI_SHAPE=VM.Standard.A1.Flex
export OCI_OCPUS=2
export OCI_MEMORY_GBS=12
export OCI_BOOT_GBS=50
export OCI_DISPLAY_NAME=my-vps
npm run check
```

It prints `signed request ok, matching instances: N`. A `401` means the fingerprint or key is wrong. A `404`/`NotAuthorized` means the user lacks access to the compartment.

## Deploy

Create the KV namespace used for the completion flag, then paste its id into `wrangler.jsonc`:

```sh
wrangler kv namespace create STATE
```

```sh
npm install
npx wrangler deploy
npx wrangler secret bulk .secrets.json
```

`wrangler deploy` prints the Worker URL and the `* * * * *` schedule. The first cron runs within a minute of the secrets upload.

After a successful launch the Worker writes `done` to KV. Every later run returns `{"status":"done"}` without calling OCI, so the cron becomes a no-op. To re-arm it after deleting the instance, call the Worker URL with `?reset=1` or delete the KV key.

A Cron Trigger cannot unregister itself. To remove the trigger entirely, set `triggers.crons` to `[]` and redeploy.

## Observe

```sh
npm run tail
```

Each run logs one line:

```json
{"status":"retry","code":500,"detail":{"code":"InternalError","message":"Out of host capacity."}}
```

When capacity appears:

```json
{"status":"created","id":"ocid1.instance.oc1..."}
```

Later runs log `{"status":"exists","id":"..."}`. You can also trigger a run over HTTP by requesting the Worker URL.

## Optional: email notification

The Worker can send one email when `my-vps` is created or first seen. Uncomment the `send_email` binding in `wrangler.jsonc`, set `NOTIFY_FROM` and `NOTIFY_TO`, and redeploy. The sending zone must have Email Routing enabled, and the destination address must be added and verified. The binding only allows sending to that one destination.

A `notified` KV key prevents duplicates, and a failed send is retried on the next cron run. `?reset=1` clears both `done` and `notified`.

## Notes

- Always Free compute is home-region only, and the home region cannot be changed. A launch in another region is billable.
- Oracle's current docs give 2 OCPU / 12 GB of A1 per month. Going above that removes the free-tier label.
- A `429 Too many requests` is a tenant-level rate limit. It is harmless; the next minute retries.
- The Worker imports the API key once per isolate and keeps CPU well under the Workers free-plan limit.
- Always Free instances can be reclaimed after a 7-day window where CPU, network, and memory are all under 20 percent. Keep real work on the box, or move to Pay As You Go.
- The Worker launches the instance outside Terraform. If you manage the instance with Terraform, import it afterwards:

```sh
terraform import oci_core_instance.this <instance-ocid>
```

- Use a dedicated OCI API key for this Worker and an IAM policy limited to the compartment, for example `Allow group <group> to manage instance-family in compartment <compartment>`.
