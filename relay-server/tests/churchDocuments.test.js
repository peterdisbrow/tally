import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createQueryClient } = require('../src/db');
const { ChurchDocuments } = require('../src/churchDocuments');

function createDb() {
  return new Database(':memory:');
}

async function createDocuments(dbOrClient, options) {
  const docs = new ChurchDocuments(dbOrClient, options);
  await docs.ready;
  return docs;
}

function toBase64(text) {
  return Buffer.from(text, 'utf-8').toString('base64');
}

describe('ChurchDocuments', () => {
  let db;
  let docs;

  beforeEach(async () => {
    db = createDb();
    docs = await createDocuments(db);
  });

  it('creates the church_documents table on construction', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'church_documents'").get();
    expect(row?.name).toBe('church_documents');
  });

  it('accepts the shared query client', async () => {
    const client = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
    const viaClient = await createDocuments(client);
    const result = await viaClient.uploadDocument(
      'church_client',
      toBase64('Camera positions and Sunday cues.\n\nUse camera 2 during prayer.'),
      'runbook.txt',
      'text/plain',
      'Alex'
    );

    expect(result.id).toBeTruthy();
    const row = db.prepare('SELECT filename FROM church_documents WHERE church_id = ?').get('church_client');
    expect(row?.filename).toBe('runbook.txt');
  });

  it('uploads plain text documents and stores chunk metadata', async () => {
    const result = await docs.uploadDocument(
      'church_a',
      toBase64('Stage manager notes.\n\nUse camera 2 during prayer.\n\nMute lobby mic after welcome.'),
      'notes.txt',
      'text/plain',
      'Jamie'
    );

    expect(result.summary).toBe('notes.txt');
    expect(result.chunkCount).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM church_documents WHERE id = ?').get(result.id);
    expect(row.filename).toBe('notes.txt');
    expect(row.uploaded_by).toBe('Jamie');
  });

  it('lists active documents for a church', async () => {
    await docs.uploadDocument('church_a', toBase64('First document content with camera notes.'), 'first.txt', 'text/plain');
    await docs.uploadDocument('church_a', toBase64('Second document content with audio notes.'), 'second.txt', 'text/plain');

    const rows = await docs.listDocuments('church_a');
    expect(rows.map((row) => row.filename).sort()).toEqual(['first.txt', 'second.txt']);
  });

  it('returns the most relevant document chunk for a query', async () => {
    await docs.uploadDocument(
      'church_a',
      toBase64('Volunteer handbook.\n\nUse camera 2 during prayer and move to a tight shot for altar calls.'),
      'handbook.txt',
      'text/plain'
    );

    const context = await docs.getDocumentContext('church_a', 'camera prayer tight shot');
    expect(context).toContain('camera 2');
    expect(context).toContain('prayer');
  });

  it('returns an empty string when the query has no strong match', async () => {
    await docs.uploadDocument(
      'church_a',
      toBase64('Lobby checklist.\n\nCheck coffee supplies after service.'),
      'lobby.txt',
      'text/plain'
    );

    const context = await docs.getDocumentContext('church_a', 'encoder bitrate sync');
    expect(context).toBe('');
  });

  it('soft-deletes a document', async () => {
    const result = await docs.uploadDocument(
      'church_a',
      toBase64('Delete me after rehearsal.'),
      'temporary.txt',
      'text/plain'
    );

    const deletion = await docs.deleteDocument('church_a', result.id);
    expect(deletion.changes).toBe(1);

    const listed = await docs.listDocuments('church_a');
    expect(listed).toHaveLength(0);
  });
});
