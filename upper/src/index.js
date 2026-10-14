export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true, service: "ch32-ahrs-uart", protocol: "ch32-uart-aa55-v3", source: "handoff-20261003 + app_command.c 20261003h + sixface + zaru + vqf-profiles (fw text not gated)", provisional: false }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
      });
    }
    return env.ASSETS.fetch(request);
  }
};
