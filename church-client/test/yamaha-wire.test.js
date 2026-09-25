/**
 * Yamaha CL / QL / TF — RCP wire format (TCP 49280).
 * Replaces the old OSC ("/ymhss/state" on 8765) and TF-MIDI tests: neither
 * protocol exists on these consoles. Exact lines are checked against Yamaha's
 * RCP parameter lists (CL/QL and TF dumps in companion-module-yamaha-rcp).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { YamahaMixer, RCP_PORT, _internals } = require('../src/mixers/yamaha');
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

/** Minimal RCP peer: records every line, answers OK with a reply that echoes the set value. */
async function recorder(product = 'CL5') {
  const lines = [];
  const values = {};
  const srv = net.createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        lines.push(line);
        const t = line.match(/(?:[^\s"]+|"[^"]*")+/g);
        if (t[0] === 'devinfo') s.write(`OK devinfo productname "${product}"\n`);
        else if (t[0] === 'devstatus') s.write('OK devstatus runmode "normal"\n');
        else if (t[0] === 'set') { values[`${t[1]} ${t[2]}`] = t.slice(4).join(' '); s.write(`OK ${line}\n`); }
        else if (t[0] === 'get') s.write(`OK get ${t[1]} ${t[2]} ${t[3]} ${values[`${t[1]} ${t[2]}`] ?? 0}\n`);
        else if (t[0] === 'ssrecall_ex') { values.scene = t[2]; s.write(`OK ssrecall_ex ${t[1]} ${t[2]}\n`); }
        else if (t[0] === 'sscurrent_ex') s.write(`OK sscurrent_ex ${t[1]} ${values.scene ?? 0}\n`);
      }
    });
    s.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, lines, sets: () => lines.filter((l) => l.startsWith('set ') || l.startsWith('ssrecall')), close: () => new Promise((r) => { srv.close(r); }) };
}
async function withMixer(product, fn) {
  const rec = await recorder(product);
  const m = new YamahaMixer({ host: '127.0.0.1', port: rec.port });
  await m.connect();
  try { await fn(m, rec); } finally { await m.disconnect(); await rec.close(); }
}

test('default and legacy ports map to RCP 49280', () => {
  assert.equal(RCP_PORT, 49280);
  assert.equal(new YamahaMixer({ host: 'h' }).port, 49280);
  assert.equal(new YamahaMixer({ host: 'h', port: 8765 }).port, 49280);
  assert.equal(new YamahaMixer({ host: 'h', port: 9765 }).port, 49280);
  assert.equal(new YamahaMixer({ host: 'h', port: 50000 }).port, 50000);
});

test('model hint picks the family limits until the console reports its product name', () => {
  assert.equal(new YamahaMixer({ host: 'h', model: 'TF' }).F.inputs, 40);
  assert.equal(new YamahaMixer({ host: 'h', model: 'QL1' }).F.inputs, 32);
  assert.equal(new YamahaMixer({ host: 'h', model: 'CL1' }).F.inputs, 48);
  assert.equal(new YamahaMixer({ host: 'h', model: 'TF' }).F.dcas, 8);
  assert.equal(new YamahaMixer({ host: 'h' }).F.dcas, 16);
});

test('fader law: X32 positions ↔ dB×100 (0.75 = 0 dB, 1.0 = +10 dB, 0 = −∞)', () => {
  const { normalToLevel, levelToNormal, levelMatches } = _internals;
  assert.equal(normalToLevel(0.75), 0);
  assert.equal(normalToLevel(1), 1000);
  assert.equal(normalToLevel(0.5), -1000);
  assert.equal(normalToLevel(0), -32768);
  assert.equal(levelToNormal(0), 0.75);
  assert.equal(levelToNormal(-32768), 0);
  assert.equal(levelToNormal(1000), 1);
  assert.equal(levelToNormal(null), null);
  assert.ok(levelMatches(-1000, -1005));
  assert.ok(!levelMatches(-1000, -1300));
  assert.ok(levelMatches(-32768, -13800));
});

test('exact RCP lines: channel mute/unmute, fader, stereo master, DCA, mute group, pan, name', async () => {
  await withMixer('CL5', async (m, rec) => {
    await m.muteChannel(1);
    await m.unmuteChannel(72);
    await m.setFader(3, 0.75);
    await m.muteMaster();
    await m.muteDca(16);
    await m.setDcaFader(1, 0);
    await m.activateMuteGroup(8);
    await m.setPan(4, 1);
    await m.setChannelName(5, 'Kick In');
    await m.setPan(6, -0.5);
    assert.deepEqual(rec.sets(), [
      'set MIXER:Current/InCh/Fader/On 0 0 0',
      'set MIXER:Current/InCh/Fader/On 71 0 1',
      'set MIXER:Current/InCh/Fader/Level 2 0 0',
      'set MIXER:Current/St/Fader/On 0 0 0',
      'set MIXER:Current/DCA/Fader/On 15 0 0',
      'set MIXER:Current/DCA/Fader/Level 0 0 -32768',
      'set MIXER:Current/MuteMaster/On 7 0 1',
      'set MIXER:Current/InCh/ToSt/Pan 3 0 63',
      'set MIXER:Current/InCh/Label/Name 4 0 "Kick In"',
      'set MIXER:Current/InCh/ToSt/Pan 5 0 -32',
    ]);
    // every set is followed by a get of the same address (read-back)
    for (const s of rec.sets()) {
      const [, addr, x] = s.split(' ');
      const i = rec.lines.indexOf(s);
      assert.equal(rec.lines[i + 1], `get ${addr} ${x} 0`, `read-back after ${s}`);
    }
  });
});

test('scene recall: CL/QL use MIXER:Lib/Scene 1–300 and read back sscurrent_ex; TF uses scene_a/scene_b', async () => {
  await withMixer('QL5', async (m, rec) => {
    const r = await m.recallScene(12);
    assert.deepEqual(r, { confirmed: true, scene: '12' });
    assert.ok(rec.lines.includes('ssrecall_ex MIXER:Lib/Scene 12'));
    assert.ok(rec.lines.includes('sscurrent_ex MIXER:Lib/Scene'));
    await assert.rejects(m.recallScene(0), /Invalid scene/);
    await assert.rejects(m.recallScene(301), /Invalid scene/);
  });
  await withMixer('TF5', async (m, rec) => {
    await m.recallScene('b07');
    assert.ok(rec.lines.includes('ssrecall_ex scene_b 7'));
    assert.ok(rec.lines.includes('sscurrent_ex scene_b'));
    await m.recallScene(3);
    assert.ok(rec.lines.includes('ssrecall_ex scene_a 3'));
    await assert.rejects(m.recallScene('A100'), /Invalid scene/);
  });
});

test('product name from the console sets the model and limits (TF5 → 40 inputs, 8 DCAs)', async () => {
  await withMixer('TF5', async (m) => {
    assert.equal(m.model, 'TF5');
    assert.equal(m.family, 'TF');
    await assert.rejects(m.muteChannel(41), /Invalid channel/);
    await assert.rejects(m.muteDca(9), /Invalid DCA/);
    await assert.rejects(m.activateMuteGroup(7), /Invalid mute group/);
  });
});

test('validation happens before anything is sent', async () => {
  await withMixer('CL5', async (m, rec) => {
    for (const bad of [() => m.muteChannel(0), () => m.muteChannel('1a'), () => m.setFader(1, -0.1), () => m.setFader(1, ''),
      () => m.setPan(1, 2), () => m.setChannelName(1, 'TooLongName'), () => m.setChannelName(1, 'a"b'), () => m.setChannelName(1, '')]) {
      await assert.rejects(bad(), /Invalid/);
    }
    assert.deepEqual(rec.sets(), []);
  });
});

test('functions RCP cannot confirm refuse with an error (never silently succeed)', async () => {
  const m = new YamahaMixer({ host: 'h' });
  for (const f of ['setHpf', 'setEq', 'setCompressor', 'setGate', 'saveScene', 'clearSolos', 'pressSoftKey', 'setChannelColor', 'setPreampGain', 'setPhantom', 'setSendLevel', 'getMeters']) {
    await assert.rejects(m[f](1, {}), /not available on Yamaha/, f);
  }
});

test('not connected → commands fail, status is offline with unknown (null) values', async () => {
  const m = new YamahaMixer({ host: '127.0.0.1', port: 1 });
  await assert.rejects(m.muteChannel(1), /not connected/);
  const s = await m.getStatus();
  assert.equal(s.online, false);
  assert.equal(s.mainMuted, null);
  assert.equal(s.mainFader, null);
  const c = await m.getChannelStatus(1);
  assert.equal(c.muted, null);
  assert.equal(c.fader, null);
});

test('tokenizer keeps quoted names with spaces together', () => {
  assert.deepEqual(_internals.tokenize('OK get MIXER:Current/InCh/Label/Name 0 0 "Lead Vox"'),
    ['OK', 'get', 'MIXER:Current/InCh/Label/Name', '0', '0', '"Lead Vox"']);
});
