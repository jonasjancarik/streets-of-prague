// Incoming mail is independent of the game Worker and its releases.
const RECIPIENTS = new Set(['news@streetsofprague.com', 'jonas@streetsofprague.com']);
const MAX_BYTES = 25 * 1024 * 1024;

export default {
  async email(message, env) {
    const recipient = message.to.toLowerCase();
    if (!RECIPIENTS.has(recipient)) {
      message.setReject('This email address does not exist.');
      return;
    }
    if (message.rawSize > MAX_BYTES) {
      message.setReject('Messages must be smaller than 25 MiB.');
      return;
    }
    // Buffer once: preserve the MIME bytes, attachments and original headers.
    const raw = await new Response(message.raw).arrayBuffer();
    const received = new Date().toISOString();
    const key = `${recipient.split('@')[0]}/${received.slice(0,10)}/${crypto.randomUUID()}.eml`;
    // Await storage before forwarding: an error must not silently lose the archive.
    await env.MAIL_ARCHIVE.put(key, raw, {
      httpMetadata: { contentType: 'message/rfc822' },
      customMetadata: { from: message.from, to: recipient, received },
    });
    try {
      await message.forward(env.FORWARD_TO, new Headers({ 'X-Original-Recipient': recipient }));
    } catch (error) {
      // The archive remains available even if the forwarding destination fails.
      console.error(JSON.stringify({ event: 'mail_forward_failed', archive: key }));
      throw error;
    }
    console.log(JSON.stringify({ event: 'mail_archived_and_forwarded', archive: key }));
  },
};
