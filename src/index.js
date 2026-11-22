import { launchInstance, listInstances } from "./oci.js";

export default {
  async scheduled(_controller, env, _ctx) {
    console.log(JSON.stringify(await ensureInstance(env)));
  },

  async fetch(_request, env) {
    const result = await ensureInstance(env);
    return Response.json(result, { status: result.status === "error" ? 502 : 200 });
  },
};

async function ensureInstance(env) {
  try {
    const existing = await listInstances(env);
    if (existing.length > 0) return { status: "exists", id: existing[0].id };

    const response = await launchInstance(env);
    if (response.status >= 300) return { status: "retry", code: response.status, detail: response.data };
    return { status: "created", id: response.data.id };
  } catch (error) {
    return { status: "error", message: error.message };
  }
}
