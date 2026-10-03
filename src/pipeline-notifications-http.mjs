import { NotificationError } from './pipeline-notifications.mjs';

/** Auth, origin and local-host checks belong to the common server gate. */
export async function notificationRoute(broker, req, res, pathname, { jsonBody, send }) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST for browser notification reception.' });
  const body = await jsonBody(req, 2048);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new NotificationError('Send notification fields as a JSON object.');
  if (pathname === '/api/notifications/ack') {
    if (Object.keys(body).some(key => !['clientId', 'lease', 'id', 'receipt', 'status'].includes(key))) throw new NotificationError('Use valid notification acknowledgement fields.');
    return send(res, 200, broker.acknowledge(body));
  }
  if (pathname !== '/api/notifications/connect') return send(res, 404, { error: 'This notification route does not exist.' });
  if (body.permission !== 'granted' || body.consent !== true || Object.keys(body).some(key => !['clientId', 'permission', 'consent'].includes(key))) throw new NotificationError('Enable browser notifications with permission before connecting.');
  let ping, client;
  const finish = () => { clearInterval(ping); if (!res.writableEnded) res.end(); };
  const write = row => {
    if (res.destroyed || res.writableEnded || res.writableLength > 131072) throw new NotificationError('The browser receiver disconnected.', 'NOTIFICATION_RECEIVER_LOST', 409);
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write(`${JSON.stringify(row)}\n`);
  };
  client = broker.connect(body.clientId, { send: write, close: finish });
  res.once('close', () => { clearInterval(ping); broker.disconnect(client); });
  ping = setInterval(() => { try { write({ type: 'ping' }); } catch { broker.disconnect(client); } }, 15000);
  if (res.destroyed) { clearInterval(ping); broker.disconnect(client); }
}
