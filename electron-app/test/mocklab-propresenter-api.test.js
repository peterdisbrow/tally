/**
 * Mock Lab's ProPresenter must speak the real ProPresenter 7 API, so the real Tally
 * driver (which only trusts GET /version + slide_index read-backs) can connect to it.
 * (Old Mock Lab served a made-up /v1/version and /v1/presentation/active shape.)
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

const { MockLabManager } = require('../src/mockLabManager');
const { FakeProPresenter } = require(path.join(__dirname, '../../church-client/src/fakeProPresenter'));
const { ProPresenter } = require(path.join(__dirname, '../../church-client/src/propresenter'));

test('Mock Lab ProPresenter works with the real driver: connect, slide, confirmed next/goTo, 404 past the end', async () => {
  const mgr = new MockLabManager(() => {});
  mgr.fakeProPresenter = new FakeProPresenter();
  const srv = http.createServer((req, res) => mgr._handleProPresenterHttp(req, res).catch(() => { res.statusCode = 500; res.end(); }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const pp = new ProPresenter({ host: '127.0.0.1', port: srv.address().port });
  try {
    assert.equal(await pp.isRunning(), true);
    assert.match(await pp.getVersion(), /ProPresenter .*Mock Lab/);
    const s = await pp.getCurrentSlide();
    assert.equal(s.presentationName, 'Sunday Service');
    assert.equal(s.slideIndex, 0);
    assert.equal(s.slideTotal, 12);
    assert.equal((await pp.nextSlide()).index, 1);
    assert.equal((await pp.goToSlide(5)).index, 5);
    await assert.rejects(pp.goToSlide(40), /refused/);
    const t = await pp.getTimerStatus();
    assert.equal(t.find((x) => x.name === 'Sermon Timer').state, 'Running');
    assert.deepEqual(await pp.getAudienceScreenStatus(), { audience: true, stage: true });
    mgr.fakeProPresenter.running = false;
    assert.equal(await pp.isRunning(), false, 'Mock Lab PP switched off is not running');
  } finally { srv.close(); }
});
