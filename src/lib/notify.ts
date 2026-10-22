import { getSettings } from "./db";

/**
 * Push a notification to the phone with the free ntfy app (https://ntfy.sh):
 * install it, subscribe to your private topic, and put the same topic in Settings.
 */
export async function notify(title: string, body: string, clickPath = "/") {
  const topic = (await getSettings()).ntfyTopic ?? process.env.NTFY_TOPIC;
  if (!topic) return false;
  const base = process.env.APP_URL ?? "";
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: { Title: title.replace(/[^\x20-\x7E]/g, ""), Click: base + clickPath, Tags: "calendar" },
    body: body.slice(0, 3900),
  }).catch(() => null);
  return Boolean(res?.ok);
}
