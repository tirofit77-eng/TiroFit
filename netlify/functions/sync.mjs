// /api/sync: TiroFit sign-in and cloud save (see ../sync-core.mjs). Data lives in Netlify Blobs.
import { getStore } from "@netlify/blobs";
import { makeHandler } from "../sync-core.mjs";

let handler = null;
export default async req => {
  if (!handler) handler = makeHandler({
    users: getStore({ name: "tirofit-users", consistency: "strong" }),
    data: getStore({ name: "tirofit-data", consistency: "strong" }),
    envSecret: process.env.AUTH_SECRET || null,
  });
  try { return await handler(req); }
  catch (err) { console.error(err); return new Response(JSON.stringify({ error: "server", message: "Sync hit a snag. Try again in a minute." }), { status: 500, headers: { "content-type": "application/json" } }); }
};
export const config = { path: "/api/sync" };
