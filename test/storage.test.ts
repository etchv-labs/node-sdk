import test from 'node:test';
import assert from 'node:assert/strict';
import { Etchv, ConflictError } from '../src/index.js';

const destination = 'dst_' + 'a'.repeat(32);
const delivery = 'std_' + 'b'.repeat(64);
const asset = 'ast_' + 'c'.repeat(64);
const record = { id: delivery, asset_id: asset, destination_id: destination, status: 'queued' };

test('storage destinations and deliveries map to the documented routes', async () => {
  const seen: string[] = [];
  const sdk = new Etchv({ apiKey: 'test-key', fetch: (async (url: URL, init: RequestInit & { headers: Record<string, string> }) => {
    assert.equal(init.headers['X-API-Key'], 'test-key');
    const route = `${init.method} ${url.pathname}${url.search}`;
    seen.push(route);
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    switch (route) {
      case 'GET /storage/destinations': return Response.json([{ id: destination }]);
      case 'POST /storage/destinations':
        assert.deepEqual(body, { name: 'Exports', provider: 'azure', bucket: 'exports', account: 'acct123', credentials: 'sv=x&sig=y' });
        return Response.json({ id: destination, provider: 'azure' }, { status: 201 });
      case `PATCH /storage/destinations/${destination}`:
        assert.deepEqual(body, { enabled: false });
        return Response.json({ id: destination, enabled: false });
      case `DELETE /storage/destinations/${destination}`: return new Response(null, { status: 204 });
      case `POST /storage/destinations/${destination}/verify`: return Response.json({ id: destination, verified_at: '2026-09-12T00:00:00Z' });
      case `GET /storage/destinations/${destination}/deliveries?after=${delivery}`: return Response.json({ items: [record], next_cursor: null });
      case `POST /storage/destinations/${destination}/deliveries`:
        assert.deepEqual(body, { asset_id: asset, key: 'reports/a.png' });
        return Response.json(record, { status: 202 });
      case `GET /storage/deliveries/${delivery}`: return Response.json({ ...record, status: 'stored' });
      case `POST /storage/deliveries/${delivery}/retry`: return Response.json(record, { status: 202 });
      case `GET /storage/deliveries/${delivery}/content`: return new Response('stored-bytes');
      default: throw new Error('unexpected ' + route);
    }
  }) as unknown as typeof fetch });
  assert.equal((await sdk.listStorageDestinations())[0].id, destination);
  assert.equal((await sdk.createStorageDestination({ name: 'Exports', provider: 'azure', bucket: 'exports', account: 'acct123', credentials: 'sv=x&sig=y' })).id, destination);
  assert.equal((await sdk.updateStorageDestination(destination, { enabled: false })).enabled, false);
  await sdk.deleteStorageDestination(destination);
  assert.ok((await sdk.verifyStorageDestination(destination)).verified_at);
  assert.equal((await sdk.listStorageDeliveries(destination, { after: delivery })).items.length, 1);
  assert.equal((await sdk.createStorageDelivery(destination, asset, { key: 'reports/a.png' })).status, 'queued');
  assert.equal((await sdk.getStorageDelivery(delivery)).status, 'stored');
  assert.equal((await sdk.retryStorageDelivery(delivery)).id, delivery);
  assert.equal(new TextDecoder().decode(await sdk.downloadStorageDelivery(delivery)), 'stored-bytes');
  assert.equal(seen.length, 10);
  for (const call of [() => sdk.verifyStorageDestination('dst_x'), () => sdk.getStorageDelivery('../assets'), () => sdk.createStorageDelivery(destination, 'ast_x')]) {
    await assert.rejects(call(), TypeError);
  }
  assert.equal(seen.length, 10);
});

test('storage validation errors never echo submitted credentials', async () => {
  const credential = 'sv=2026&sig=etchv_' + 'z'.repeat(30);
  const sdk = new Etchv({ apiKey: 'test-key', fetch: (async () => Response.json(
    { detail: `Destination changed; reload it (${credential})` }, { status: 409, headers: { 'x-request-id': 'req_store' } },
  )) as unknown as typeof fetch });
  await assert.rejects(sdk.updateStorageDestination(destination, { credentials: credential }), (e: any) => {
    assert.ok(e instanceof ConflictError);
    assert.equal(e.requestId, 'req_store');
    assert.ok(!e.message.includes('etchv_zz'));
    assert.ok(!e.message.includes('test-key'));
    return true;
  });
});
