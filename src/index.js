import { launchInstance, listInstances } from "./oci.js";

export default {
  async scheduled(_controller, env, _ctx) {
    console.log(JSON.stringify(await ensureInstance(env)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.has("reset")) {
      await env.STATE.delete("done");
      await env.STATE.delete("notified");
      return Response.json({ status: "reset" });
    }
    const result = await ensureInstance(env);
    return Response.json(result, { status: result.status === "error" ? 502 : 200 });
  },
};

async function ensureInstance(env) {
  try {
    const done = await env.STATE.get("done");
    if (done) {
      await notify(env, { id: done });
      return { status: "done", id: done };
    }

    const existing = await listInstances(env);
    if (existing.length > 0) {
      await settle(env, existing[0]);
      return { status: "exists", id: existing[0].id };
    }

    const response = await launchInstance(env);
    if (response.status >= 300) return { status: "retry", code: response.status, detail: response.data };

    await settle(env, response.data);
    return { status: "created", id: response.data.id };
  } catch (error) {
    return { status: "error", message: error.message };
  }
}

async function settle(env, instance) {
  await env.STATE.put("done", instance.id);
  await notify(env, instance);
}

async function notify(env, instance) {
  if (!env.EMAIL) return;
  if (await env.STATE.get("notified")) return;

  try {
    await env.EMAIL.send({
      to: env.NOTIFY_TO,
      from: env.NOTIFY_FROM,
      subject: "my-vps is up: A1.Flex instance acquired",
      text: emailBody(instance),
    });
  } catch (error) {
    console.log(JSON.stringify({ notify: "failed", message: error.message }));
    return;
  }

  await env.STATE.put("notified", instance.id);
}

function emailBody(instance) {
  const lines = [
    "Oracle Cloud provisioned the Always Free A1.Flex instance.",
    "",
    `Instance: ${instance.id}`,
  ];

  const domain = instance["availability-domain"];
  if (domain) lines.push(`Availability domain: ${domain}`);

  lines.push(
    "",
    "Import it into Terraform:",
    "  cd infra",
    `  terraform import oci_core_instance.this ${instance.id}`,
    "  terraform plan",
    "",
    "Console: https://cloud.oracle.com/compute/instances",
  );

  return lines.join("\n");
}
