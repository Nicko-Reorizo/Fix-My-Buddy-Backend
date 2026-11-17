import { withTransaction } from '../db/pool.js';

function messageDto(row) {
  return { id: String(row.id), sender: row.sender, body: row.body,
    clientId: row.client_id.replace(/^(customer|provider):/, ''),
    createdAt: new Date(row.created_at).toISOString(),
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null };
}

export function registerBookingMessages(router, prefix, role) {
  const path = `${prefix}/:id/:channel(mechanic|towing)/messages`;
  const sender = role === 'customer' ? 'customer' : 'provider';
  async function owned(client, req) {
    const result = await client.query(role === 'customer'
      ? 'SELECT service_type FROM bookings WHERE id=$1 AND customer_id=$2'
      : 'SELECT b.service_type FROM bookings b JOIN mechanic_profiles p ON p.id=b.provider_id WHERE b.id=$1 AND p.user_id=$2',
    [req.params.id, req.user.id]);
    if (!result.rows.length || result.rows[0].service_type !== req.params.channel) {
      const error = new Error('Booking conversation not found.'); error.status = 404; throw error;
    }
  }
  router.get(path, async (req, res, next) => {
    try {
      const messages = await withTransaction(async client => {
        await owned(client, req);
        await client.query('UPDATE booking_messages SET read_at=NOW() WHERE booking_id=$1 AND channel=$2 AND sender<>$3 AND read_at IS NULL', [req.params.id,req.params.channel,sender]);
        const result = await client.query('SELECT * FROM booking_messages WHERE booking_id=$1 AND channel=$2 ORDER BY created_at,id', [req.params.id,req.params.channel]);
        return result.rows.map(messageDto);
      });
      return res.json({ messages });
    } catch (error) { return next(error); }
  });
  router.post(path, async (req, res, next) => {
    try {
      const { body, clientId } = req.body || {};
      if (typeof body !== 'string' || !body.trim() || body.trim().length > 2000 || typeof clientId !== 'string' || !clientId.trim() || clientId.length > 128) return res.status(400).json({ error: 'A message up to 2000 characters and a valid clientId are required.' });
      const message = await withTransaction(async client => {
        await owned(client,req);
        const key = `${sender}:${clientId}`;
        const result = await client.query(`INSERT INTO booking_messages (booking_id,channel,sender,body,client_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (booking_id,channel,client_id) DO NOTHING RETURNING *`,[req.params.id,req.params.channel,sender,body.trim(),key]);
        const row = result.rows[0] || (await client.query('SELECT * FROM booking_messages WHERE booking_id=$1 AND channel=$2 AND client_id=$3',[req.params.id,req.params.channel,key])).rows[0];
        if (row.sender !== sender || row.body !== body.trim()) { const error = new Error('This message ID was already used.'); error.status=409; throw error; }
        return messageDto(row);
      });
      return res.status(201).json({ message });
    } catch (error) { return next(error); }
  });
}
