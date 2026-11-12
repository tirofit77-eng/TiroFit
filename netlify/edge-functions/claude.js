// TiroFit AI endpoint: the web app sends a conversation here and gets Claude's reply streamed back.
// The API key stays on the server (Netlify env var ANTHROPIC_API_KEY). Tools run in the browser:
// this endpoint only relays tool definitions and returns tool_use blocks for the page to execute.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const MAX_BODY = 8 * 1024 * 1024; // photos are downscaled in the browser first
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  if (req.method === "GET") return json({ ok: !!key });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!key) return json({ error: "no_key", message: "ANTHROPIC_API_KEY is not set in Netlify." }, 503);
  // Only accept calls from this site's own pages.
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(req.url).host) return json({ error: "forbidden" }, 403);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);
  let body; try { body = JSON.parse(raw); } catch { return json({ error: "bad_json" }, 400); }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : null;
  if (!messages?.length) return json({ error: "no_messages" }, 400);
  const tools = Array.isArray(body.tools) ? body.tools.slice(0, 12).map(t => ({ name: String(t.name), description: String(t.description || ""), input_schema: t.input_schema || { type: "object", properties: {} } })) : undefined;

  const client = new Anthropic({ apiKey: key });
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = o => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      try {
        const s = client.beta.messages.stream({
          model: MODEL,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: body.effort === "medium" ? "medium" : "low" },
          ...(body.system ? { system: String(body.system) } : {}),
          ...(tools?.length ? { tools } : {}),
          messages,
        });
        s.on("text", delta => send({ d: delta }));
        const msg = await s.finalMessage();
        send({ done: { content: msg.content, stop_reason: msg.stop_reason } });
      } catch (err) {
        const status = err?.status;
        send({ error: status === 429 ? "rate_limited" : status === 401 ? "bad_key" : status === 400 ? "bad_request" : "failed", message: String(err?.message || err).slice(0, 300) });
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
};

export const config = { path: "/api/claude" };
