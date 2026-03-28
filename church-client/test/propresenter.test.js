const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ProPresenter } = require('../src/propresenter');
const { FakeProPresenter } = require('../src/fakeProPresenter');

describe('ProPresenter', () => {
  describe('toStatus()', () => {
    it('returns all expected fields', () => {
      const pp = new ProPresenter({ host: 'localhost', port: 1025 });
      const status = pp.toStatus();
      assert.equal(status.connected, false);
      assert.equal(status.running, false);
      assert.equal(status.version, null);
      assert.equal(status.currentSlide, null);
      assert.equal(status.presentationUUID, null);
      assert.equal(status.slideIndex, null);
      assert.equal(status.slideTotal, null);
      assert.equal(status.slideNotes, null);
      assert.equal(status.activeLook, null);
      assert.deepEqual(status.timers, []);
      assert.equal(status.screens, null);
      assert.equal(status.playlistFocused, null);
      assert.equal(status.triggerMode, 'presentation');
      assert.equal(status.backup, null);
    });

    it('includes backup status when backup is configured', () => {
      const pp = new ProPresenter({ host: 'localhost', port: 1025, backupHost: '192.168.1.2' });
      const status = pp.toStatus();
      assert.ok(status.backup);
      assert.equal(status.backup.connected, false);
      assert.equal(status.backup.running, false);
    });
  });

  describe('trigger mode', () => {
    it('defaults to presentation mode', () => {
      const pp = new ProPresenter({ host: 'localhost', port: 1025 });
      assert.equal(pp.triggerMode, 'presentation');
    });

    it('accepts playlist mode', () => {
      const pp = new ProPresenter({ host: 'localhost', port: 1025, triggerMode: 'playlist' });
      assert.equal(pp.triggerMode, 'playlist');
    });

    it('includes triggerMode in toStatus()', () => {
      const pp = new ProPresenter({ host: 'localhost', port: 1025, triggerMode: 'playlist' });
      assert.equal(pp.toStatus().triggerMode, 'playlist');
    });
  });

  describe('constructor defaults', () => {
    it('sets default host and port', () => {
      const pp = new ProPresenter();
      assert.equal(pp.host, 'localhost');
      assert.equal(pp.port, 1025);
    });

    it('accepts custom host and port', () => {
      const pp = new ProPresenter({ host: '10.0.0.5', port: 2025 });
      assert.equal(pp.host, '10.0.0.5');
      assert.equal(pp.port, 2025);
    });

    it('baseUrl returns correct URL', () => {
      const pp = new ProPresenter({ host: '10.0.0.5', port: 2025 });
      assert.equal(pp.baseUrl, 'http://10.0.0.5:2025');
    });
  });

  describe('backup mirroring', () => {
    it('creates backup instance when backupHost is provided', () => {
      const pp = new ProPresenter({ host: 'localhost', backupHost: '192.168.1.2', backupPort: 1025 });
      assert.ok(pp._backup);
      assert.equal(pp._backup.host, '192.168.1.2');
      assert.equal(pp._backup.port, 1025);
    });

    it('does not create backup when backupHost is not provided', () => {
      const pp = new ProPresenter({ host: 'localhost' });
      assert.equal(pp._backup, null);
    });

    it('backup does not have its own backup (no recursion)', () => {
      const pp = new ProPresenter({ host: 'localhost', backupHost: '192.168.1.2' });
      assert.equal(pp._backup._backup, null);
    });
  });

  describe('disconnect', () => {
    it('cleans up timers and state', () => {
      const pp = new ProPresenter({ host: 'localhost', backupHost: '10.0.0.2' });
      pp.connected = true;
      pp.disconnect();
      assert.equal(pp.connected, false);
      assert.equal(pp._backup.connected, false);
    });
  });
});

describe('FakeProPresenter', () => {
  let fake;
  beforeEach(() => { fake = new FakeProPresenter(); });

  describe('toStatus()', () => {
    it('returns all rich status fields', () => {
      const status = fake.toStatus();
      assert.equal(status.connected, false);
      assert.equal(status.running, true);
      assert.equal(status.version, '7.16');
      assert.equal(status.currentSlide, 'Sunday Service');
      assert.equal(status.presentationUUID, 'fake-uuid-001');
      assert.equal(status.slideIndex, 0);
      assert.equal(status.slideTotal, 12);
      assert.ok(status.slideNotes);
      assert.ok(status.activeLook);
      assert.equal(status.activeLook.name, 'Worship');
      assert.ok(Array.isArray(status.timers));
      assert.ok(status.screens);
      assert.ok(status.playlistFocused);
      assert.equal(status.triggerMode, 'presentation');
      assert.equal(status.backup, null);
    });
  });

  describe('rich status methods', () => {
    it('getActiveLook returns active look', async () => {
      const look = await fake.getActiveLook();
      assert.equal(look.name, 'Worship');
    });

    it('getTimerStatus returns timers with state', async () => {
      const timers = await fake.getTimerStatus();
      assert.ok(timers.length >= 2);
      assert.ok(timers[0].time);
      assert.ok(timers[0].state);
    });

    it('getTimerStatus simulates countdown', async () => {
      const t1 = await fake.getTimerStatus();
      const time1 = t1[0].time;
      const t2 = await fake.getTimerStatus();
      const time2 = t2[0].time;
      // Timer should have decremented
      assert.notEqual(time1, time2);
    });

    it('getAudienceScreenStatus returns screen state', async () => {
      const screens = await fake.getAudienceScreenStatus();
      assert.equal(screens.audience, true);
      assert.equal(screens.stage, true);
    });

    it('getPlaylistFocused returns playlist info', async () => {
      const pl = await fake.getPlaylistFocused();
      assert.equal(pl.name, 'Main Service');
    });

    it('getLibraries returns library structure', async () => {
      const libs = await fake.getLibraries();
      assert.equal(libs.length, 2);
      assert.equal(libs[0].name, 'Songs');
      assert.ok(libs[0].presentations.length > 0);
    });

    it('getThumbnail returns base64 string', async () => {
      const thumb = await fake.getThumbnail('fake-uuid', 0);
      assert.ok(typeof thumb === 'string');
      assert.ok(thumb.length > 0);
    });

    it('setAudienceScreens toggles state', async () => {
      await fake.setAudienceScreens(false);
      const screens = await fake.getAudienceScreenStatus();
      assert.equal(screens.audience, false);
    });
  });

  describe('getCurrentSlide with rich data', () => {
    it('includes presentationUUID and slideNotes', async () => {
      const slide = await fake.getCurrentSlide();
      assert.ok(slide.presentationUUID);
      assert.ok(slide.slideNotes);
    });
  });

  describe('getVersion', () => {
    it('returns version string', async () => {
      const v = await fake.getVersion();
      assert.equal(v, '7.16');
    });
  });

  describe('navigation', () => {
    it('nextSlide advances index', async () => {
      assert.equal(fake._slideIndex, 0);
      await fake.nextSlide();
      assert.equal(fake._slideIndex, 1);
    });

    it('previousSlide decreases index', async () => {
      fake._slideIndex = 5;
      await fake.previousSlide();
      assert.equal(fake._slideIndex, 4);
    });

    it('goToSlide jumps to index', async () => {
      await fake.goToSlide(7);
      assert.equal(fake._slideIndex, 7);
    });

    it('goToSlide clamps to bounds', async () => {
      await fake.goToSlide(999);
      assert.equal(fake._slideIndex, 11); // slideTotal is 12
    });
  });
});
