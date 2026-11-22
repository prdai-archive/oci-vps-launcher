import { launchInstance, listInstances } from "./oci.js";

export default {
  async scheduled(_controller, env, _ctx) {
    console.log(JSON.stringify(await ensureInstance(env)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.has("reset")) {
      await env.STATE.delete("done");
      return Response.json({ status: "reset" });
    }
    const result = await ensureInstance(env);
    return Response.json(result, { status: result.status === "error" ? 502 : 200 });
  },
};

async function ensureInstance(env) {
  try {
    const done = await env.STATE.get("done");
    if (done) return { status: "done", id: done };

    const existing = await listInstances(env);
    if (existing.length > 0) {
      await env.STATE.put("done", existing[0].id);
      return { status: "exists", id: existing[0].id };
    }

    const response = await launchInstance(env);
    if (response.status >= 300) return { status: "retry", code: response.status, detail: response.data };

    await env.STATE.put("done", response.data.id);
    return { status: "created", id: response.data.id };
  } catch (error) {
    return { status: "error", message: error.message };
  }
}
