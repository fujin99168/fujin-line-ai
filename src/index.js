export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("Fujin LINE AI OK", { status: 200 });
    }

    if (request.method === "POST") {
      const body = await request.text();
      console.log("LINE Webhook:", body);

      return new Response("OK", { status: 200 });
    }

    return new Response("OK", { status: 200 });
  }
};
