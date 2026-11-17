import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import process from 'node:process';
import { createApp } from '../server.js';
import { getPool } from '../db/pool.js';
import { hashToken } from './crypto.js';

// Opt-in: fixtures and all API writes share one transaction, rolled back at exit.
test('real matching, availability, booking delivery, acceptance and account isolation', { skip: process.env.RUN_DATABASE_TESTS !== '1' }, async () => {
  const pool = await getPool();
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const client = await pool.connect();
  let server;
  try {
    await client.query('BEGIN');
    pool.query = (...args) => client.query(...args);
    pool.connect = async () => ({
      query: (sql, values) => client.query(sql === 'BEGIN' ? 'SAVEPOINT api_transaction' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT api_transaction' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT api_transaction' : sql, values),
      release() {},
    });
    const suffix = crypto.randomUUID();
    async function account(role) {
      const r = await client.query(`INSERT INTO users (role,name,email,password_hash,phone_verified,accepted_terms) VALUES ($1,$2,$3,'test-only',TRUE,TRUE) RETURNING id`, [role, `Test ${role}`, `${role}-${crypto.randomUUID()}@integration.invalid`]);
      const id = r.rows[0].id;
      const token = crypto.randomUUID();
      await client.query(`INSERT INTO auth_sessions (user_id,token_hash,role,expires_at) VALUES ($1,$2,$3,NOW()+interval '1 hour')`, [id,hashToken(token),role]);
      return { id, token };
    }
    const customer = await account('customer');
    const otherCustomer = await account('customer');
    const mechanic = await account('mechanic');
    const other = await account('mechanic');
    const proId = `TEST-${suffix}`;
    await client.query(`INSERT INTO mechanic_profiles (id,user_id,display_name,online,specialties,latitude,longitude,position_updated_at) VALUES ($1,$2,'Real test mechanic',FALSE,ARRAY['Battery'],13.62,123.19,NOW())`, [proId,mechanic.id]);
    server = createApp().listen(0,'127.0.0.1');
    await new Promise(resolve => server.once('listening',resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function call(path, user, method='GET', body) {
      const response = await fetch(base+path,{ method,headers:{'content-type':'application/json',cookie:`fmb_session=${user.token}`},...(body ? {body:JSON.stringify(body)} : {}) });
      return {status:response.status,data:await response.json()};
    }
    const search = () => call('/providers/search',customer,'POST',{serviceType:'mechanic',location:{latitude:13.62,longitude:123.19},filters:{radiusKm:5}});
    const hasMechanic = result => result.data.providers.some(p=>p.id===proId);
    assert.equal(hasMechanic(await search()),false,'offline mechanics are hidden');
    assert.equal((await call('/mechanics/me/availability',mechanic,'PATCH',{online:true})).status,400,'online requires GPS');
    assert.equal((await call('/mechanics/me/availability',mechanic,'PATCH',{online:true,location:{latitude:13.62,longitude:123.19}})).status,200);
    assert.equal(hasMechanic(await search()),true,'online real account becomes matchable');
    const manual = { latitude:13.6201, longitude:123.1901, source:'manual', address:'Selected workshop location' };
    assert.equal((await call('/mechanics/me/availability',mechanic,'PATCH',{online:true,location:manual})).status,200);
    let savedProfile = await call('/mechanics/me',mechanic);
    assert.deepEqual(savedProfile.data.mechanic.location,manual,'manual pin and address persist');
    await call('/mechanics/me/location',mechanic,'POST',{latitude:14,longitude:124});
    savedProfile = await call('/mechanics/me',mechanic);
    assert.deepEqual(savedProfile.data.mechanic.location,manual,'GPS background updates cannot overwrite a manual pin');
    await client.query(`UPDATE mechanic_profiles SET position_updated_at=NOW()-interval '10 minutes' WHERE id=$1`,[proId]);
    assert.equal(hasMechanic(await search()),false);
    assert.equal((await call('/mechanics/me/presence',mechanic,'POST',{})).status,200);
    assert.equal(hasMechanic(await search()),true,'manual-location presence restores availability without GPS');
    assert.equal((await call('/mechanics/me/availability',mechanic,'PATCH',{online:true,location:{latitude:13.62,longitude:123.19,source:'gps'}})).status,200);
    assert.equal((await search()).data.providers.some(p=>p.id==='PRO-0042'),false,'seed mechanic never matches');
    await client.query(`UPDATE mechanic_profiles SET position_updated_at=NOW()-interval '10 minutes' WHERE id=$1`,[proId]);
    assert.equal(hasMechanic(await search()),false,'stale mechanics are hidden');
    assert.equal((await call('/mechanics/me/location',mechanic,'POST',{latitude:13.62,longitude:123.19})).status,200);
    const vehicle = await client.query(`INSERT INTO vehicles (user_id,type,make,model,year,color) VALUES ($1,'car','Test','Car',2025,'Blue') RETURNING id`,[customer.id]);
    await client.query(`INSERT INTO cancellation_policies (id,text,active) VALUES ('policy-standard-v1','Test policy',TRUE) ON CONFLICT DO NOTHING`);
    const booking = await call('/customers/me/bookings',customer,'POST',{providerId:proId,vehicleId:vehicle.rows[0].id,serviceType:'mechanic',issueType:'Battery',location:{latitude:13.62,longitude:123.19,address:'Integration pickup'},estimateId:'test-estimate',cancellationPolicyId:'policy-standard-v1',repairsApproved:false});
    assert.equal(booking.status,201,JSON.stringify(booking.data));
    const id = booking.data.booking.id;
    const customerChat = `/customers/me/bookings/${id}/mechanic/messages`;
    const mechanicChat = `/mechanics/me/jobs/${id}/mechanic/messages`;
    assert.equal((await call(`/customers/me/bookings/${id}/review`,customer,'PUT',{rating:5,clientId:'early'})).status,409,'cannot rate unfinished work');
    const firstMessage = await call(customerChat,customer,'POST',{body:'Please meet me at the gate.',clientId:'same-id'});
    assert.equal(firstMessage.status,201);
    const replay = await call(customerChat,customer,'POST',{body:'Please meet me at the gate.',clientId:'same-id'});
    assert.equal(replay.data.message.id,firstMessage.data.message.id,'retries do not duplicate messages');
    assert.equal((await call(customerChat,customer,'POST',{body:'Attempt to rewrite',clientId:'same-id'})).status,409);
    const inbox = await call(mechanicChat,mechanic);
    assert.equal(inbox.data.messages[0].body,'Please meet me at the gate.');
    assert.ok(inbox.data.messages[0].readAt,'mechanic read receipt is stored');
    const reply = await call(mechanicChat,mechanic,'POST',{body:'I will meet you there.',clientId:'same-id'});
    assert.equal(reply.status,201);
    assert.equal(reply.data.message.sender,'provider');
    assert.notEqual(reply.data.message.id,firstMessage.data.message.id,'participant IDs cannot overwrite each other');
    const conversation = await call(customerChat,customer);
    assert.equal(conversation.data.messages.length,2);
    assert.ok(conversation.data.messages.find(m=>m.sender==='provider').readAt);
    assert.equal((await call(mechanicChat,other)).status,404);
    assert.equal((await call(mechanicChat,other,'POST',{body:'Intruder',clientId:'x'})).status,404);
    assert.equal((await call(customerChat,otherCustomer)).status,404);
    assert.equal((await call(`/mechanics/me/jobs/${id}/towing/messages`,mechanic)).status,404,'wrong service channel is rejected');
    assert.equal((await call(mechanicChat,mechanic,'POST',{body:'x'.repeat(2001),clientId:'too-long'})).status,400);
    const jobs = await call('/mechanics/me/jobs',mechanic);
    assert.equal(jobs.data.jobs.some(j=>j.id===id),true,'customer request reaches assigned mechanic');
    assert.equal((await call(`/mechanics/me/jobs/${id}`,other)).status,404,'other mechanic cannot read request');
    assert.equal((await call(`/mechanics/me/jobs/${id}/completion`,mechanic,'POST',{})).status,409,'cannot fake completion');
    assert.equal((await call(`/mechanics/me/jobs/${id}/accept`,mechanic,'POST',{})).status,200);
    assert.equal(hasMechanic(await search()),false,'busy mechanics are hidden');
    const customerBookings = await call('/customers/me/bookings',customer);
    assert.equal(customerBookings.data.bookings.find(b=>b.id===id).status,'en_route','customer sees acceptance');
    const pin = await call(`/customers/me/bookings/${id}/mechanic/arrival-pin`,customer);
    assert.equal((await call(`/mechanics/me/jobs/${id}/arrival-verification`,mechanic,'POST',{pin:pin.data.pin})).status,200);
    assert.equal((await call(`/mechanics/me/jobs/${id}/completion`,mechanic,'POST',{})).status,200);
    const finished = await client.query('SELECT status,payment_status,paid_amount,receipt_available FROM bookings WHERE id=$1',[id]);
    assert.equal(finished.rows[0].status,'completed');
    assert.equal(finished.rows[0].payment_status,'unverified','completion must not pretend to verify payment');
    assert.equal(finished.rows[0].paid_amount,null);
    assert.equal(finished.rows[0].receipt_available,false);
    const reviewPath = `/customers/me/bookings/${id}/review`;
    assert.equal((await call(reviewPath,otherCustomer,'PUT',{rating:5,clientId:'intruder'})).status,404);
    assert.equal((await call(reviewPath,customer,'PUT',{rating:6,clientId:'invalid'})).status,400);
    const review = await call(reviewPath,customer,'PUT',{rating:4,body:'Helpful service',clientId:'rating-one'});
    assert.equal(review.status,200);
    const duplicate = await call(reviewPath,customer,'PUT',{rating:4,body:'Helpful service',clientId:'rating-one'});
    assert.equal(duplicate.data.review.version,1,'rating retry does not count twice');
    let ratedProfile = await call('/mechanics/me',mechanic);
    assert.equal(ratedProfile.data.mechanic.rating,4);
    assert.equal(ratedProfile.data.mechanic.reviewsCount,1);
    assert.equal((await search()).data.providers.find(p=>p.id===proId).rating,4,'search shows actual rating');
    assert.equal((await call('/mechanics/me/reviews',mechanic)).data.reviews[0].body,'Helpful service');
    assert.equal((await call(reviewPath,customer,'PUT',{rating:5,version:99,clientId:'stale'})).status,409,'stale review edits rejected');
    const secondId = `REVIEW-${suffix}`;
    await client.query(`INSERT INTO bookings (id,reference,customer_id,provider_id,vehicle_label,service_type,issue_type,pickup_address,status) VALUES ($1,$1,$2,$3,'Test vehicle','mechanic','Battery','Test pickup','completed')`,[secondId,customer.id,proId]);
    assert.equal((await call(`/customers/me/bookings/${secondId}/review`,customer,'PUT',{rating:2,clientId:'rating-two'})).status,200);
    assert.equal((await call(reviewPath,customer,'PUT',{rating:5,body:'Updated feedback',version:1,clientId:'rating-edit'})).status,200);
    ratedProfile = await call('/mechanics/me',mechanic);
    assert.equal(ratedProfile.data.mechanic.rating,3.5,'average reflects review updates');
    assert.equal(ratedProfile.data.mechanic.reviewsCount,2,'editing does not inflate review count');
    assert.equal((await call('/mechanics/me/location',customer,'POST',{latitude:13.62,longitude:123.19})).status,403);
    console.log('Verified matching → booking → mechanic inbox → accept → customer status → PIN arrival → completion. Fixtures rolled back.');
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    pool.query=originalQuery; pool.connect=originalConnect;
    await client.query('ROLLBACK'); client.release(); await pool.end();
  }
});
