import { describe, it, expect } from 'vitest';
import { setupStatusPage } from '../src/statusPage.js';

// ─── buildStatusPageHtml (via setupStatusPage) ────────────────────────────────
// statusPage.js exports setupStatusPage which calls buildStatusPageHtml internally.
// We test the HTML content by capturing what setupStatusPage registers.

describe('setupStatusPage()', () => {
  it('registers a GET /status route', () => {
    const routes = [];
    const mockApp = {
      get: (path, handler) => routes.push({ path, handler }),
    };
    setupStatusPage(mockApp);
    expect(routes.length).toBe(1);
    expect(routes[0].path).toBe('/status');
  });

  it('handler sets Content-Type to text/html', () => {
    let capturedContentType = null;
    const mockApp = {
      get: (path, handler) => {
        const res = {
          setHeader: (key, val) => { capturedContentType = val; },
          send: () => {},
        };
        handler({}, res);
      },
    };
    setupStatusPage(mockApp);
    expect(capturedContentType).toBe('text/html; charset=utf-8');
  });

  it('handler sends valid HTML containing doctype', () => {
    let capturedHtml = null;
    const mockApp = {
      get: (path, handler) => {
        const res = {
          setHeader: () => {},
          send: (html) => { capturedHtml = html; },
        };
        handler({}, res);
      },
    };
    setupStatusPage(mockApp);
    expect(capturedHtml).toContain('<!DOCTYPE html>');
  });

  it('handler HTML contains page title', () => {
    let capturedHtml = null;
    const mockApp = {
      get: (path, handler) => {
        const res = {
          setHeader: () => {},
          send: (html) => { capturedHtml = html; },
        };
        handler({}, res);
      },
    };
    setupStatusPage(mockApp);
    expect(capturedHtml).toContain('Tally Status');
  });

  it('handler HTML contains status platform heading', () => {
    let capturedHtml = null;
    const mockApp = {
      get: (path, handler) => {
        const res = {
          setHeader: () => {},
          send: (html) => { capturedHtml = html; },
        };
        handler({}, res);
      },
    };
    setupStatusPage(mockApp);
    expect(capturedHtml).toContain('Tally Platform Status');
  });

  it('handler HTML contains church-portal link', () => {
    let capturedHtml = null;
    const mockApp = {
      get: (path, handler) => {
        const res = {
          setHeader: () => {},
          send: (html) => { capturedHtml = html; },
        };
        handler({}, res);
      },
    };
    setupStatusPage(mockApp);
    expect(capturedHtml).toContain('/church-portal');
  });

  it('handler HTML contains API endpoint for status components', () => {
    let capturedHtml = null;
    const mockApp = {
      get: (path, handler) => {
        const res = {
          setHeader: () => {},
          send: (html) => { capturedHtml = html; },
        };
        handler({}, res);
      },
    };
    setupStatusPage(mockApp);
    expect(capturedHtml).toContain('/api/status/components');
  });

  it('handler HTML is well-formed with closing html tag', () => {
    let capturedHtml = null;
    const mockApp = {
      get: (path, handler) => {
        const res = {
          setHeader: () => {},
          send: (html) => { capturedHtml = html; },
        };
        handler({}, res);
      },
    };
    setupStatusPage(mockApp);
    expect(capturedHtml).toContain('</html>');
    expect(capturedHtml.indexOf('<!DOCTYPE html>')).toBeLessThan(
      capturedHtml.indexOf('</html>')
    );
  });

  it('HTML includes auto-refresh script with setInterval', () => {
    let capturedHtml = null;
    const mockApp = {
      get: (path, handler) => {
        const res = {
          setHeader: () => {},
          send: (html) => { capturedHtml = html; },
        };
        handler({}, res);
      },
    };
    setupStatusPage(mockApp);
    expect(capturedHtml).toContain('setInterval');
    expect(capturedHtml).toContain('60000');
  });

  it('HTML includes CSS for operational/degraded/outage status classes', () => {
    let capturedHtml = null;
    const mockApp = {
      get: (path, handler) => {
        const res = {
          setHeader: () => {},
          send: (html) => { capturedHtml = html; },
        };
        handler({}, res);
      },
    };
    setupStatusPage(mockApp);
    expect(capturedHtml).toContain('s-operational');
    expect(capturedHtml).toContain('s-degraded');
    expect(capturedHtml).toContain('s-outage');
  });
});
