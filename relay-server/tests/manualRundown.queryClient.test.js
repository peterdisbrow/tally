import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'module';
import { createQueryClient } from '../src/db/queryClient.js';

const require = createRequire(import.meta.url);
const { ManualRundownStore } = require('../src/manualRundown');

const SQLITE_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

describe('ManualRundownStore column metadata', () => {
  let db;
  let queryClient;
  let store;

  beforeEach(async () => {
    db = new Database(':memory:');
    queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
    store = new ManualRundownStore({ queryClient, log: () => {} });
    await store.ready;
  });

  afterEach(async () => {
    await queryClient?.close();
    db?.close();
  });

  it('persists typed column metadata with dropdown options and live bindings', async () => {
    const plan = await store.createPlan('church-1', { title: 'Sunday Service' });

    await store.addColumn(plan.id, 'church-1', {
      name: 'Camera',
      type: 'dropdown',
      options: ['Wide', 'Close', 'Wide', '  '],
      equipmentBinding: 'atem.program_input',
    });

    const columns = await store.getColumns(plan.id);
    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({
      name: 'Camera',
      type: 'dropdown',
      options: ['Wide', 'Close'],
      equipmentBinding: 'atem.program_input',
    });
  });

  it('updates column type metadata and clears stale dropdown options when switching back to text', async () => {
    const plan = await store.createPlan('church-1', { title: 'Wednesday Rehearsal' });
    const column = await store.addColumn(plan.id, 'church-1', { name: 'Slides' });

    await store.updateColumn(column.id, {
      type: 'dropdown',
      options: ['Intro', 'Verse', 'Outro'],
      equipmentBinding: 'propresenter.presentation',
    });

    let columns = await store.getColumns(plan.id);
    expect(columns[0]).toMatchObject({
      type: 'dropdown',
      options: ['Intro', 'Verse', 'Outro'],
      equipmentBinding: 'propresenter.presentation',
    });

    await store.updateColumn(column.id, { type: 'text' });

    columns = await store.getColumns(plan.id);
    expect(columns[0]).toMatchObject({
      type: 'text',
      options: [],
      equipmentBinding: 'propresenter.presentation',
    });
  });

  it('copies typed columns and values into templates', async () => {
    const plan = await store.createPlan('church-1', { title: 'Template Source' });
    const item = await store.addItem(plan.id, { title: 'Welcome', itemType: 'other' });
    const column = await store.addColumn(plan.id, 'church-1', {
      name: 'Shot',
      type: 'dropdown',
      options: ['Cam 1', 'Cam 2'],
      equipmentBinding: 'atem.program_input',
    });
    await store.setColumnValue(item.id, column.id, 'Cam 1');

    const template = await store.saveAsTemplate(plan.id, 'Sunday Template');
    const templateColumns = await store.getColumns(template.id);
    const templateValues = await store.getColumnValues(template.id);

    expect(templateColumns).toHaveLength(1);
    expect(templateColumns[0]).toMatchObject({
      name: 'Shot',
      type: 'dropdown',
      options: ['Cam 1', 'Cam 2'],
      equipmentBinding: 'atem.program_input',
    });
    expect(templateValues).toHaveLength(1);
    expect(templateValues[0].value).toBe('Cam 1');
  });

  it('duplicates hard-start item metadata and custom column values', async () => {
    const plan = await store.createPlan('church-1', { title: 'Sunday AM' });
    const item = await store.addItem(plan.id, {
      title: 'Walk-in',
      itemType: 'other',
      lengthSeconds: 120,
      startType: 'hard',
      hardStartTime: '09:15',
      autoAdvance: true,
    });
    const column = await store.addColumn(plan.id, 'church-1', {
      name: 'Camera',
      type: 'dropdown',
      options: ['Wide', 'Tight'],
    });
    await store.setColumnValue(item.id, column.id, 'Wide');

    const copy = await store.duplicatePlan(plan.id);
    const copyColumns = await store.getColumns(copy.id);
    const copyValues = await store.getColumnValues(copy.id);

    expect(copy.items).toHaveLength(1);
    expect(copy.items[0]).toMatchObject({
      title: 'Walk-in',
      startType: 'hard',
      hardStartTime: '09:15',
      autoAdvance: true,
    });
    expect(copyColumns).toHaveLength(1);
    expect(copyValues).toHaveLength(1);
    expect(copyValues[0].value).toBe('Wide');
  });

  it('only resolves legacy timer tokens while an active share exists', async () => {
    const plan = await store.createPlan('church-1', { title: 'Guest Link Test' });
    const share = await store.createShare(plan.id, 'church-1', { expiresInDays: 1 });
    await store.setShareToken(plan.id, 'legacy-token');

    await expect(store.resolvePublicAccess(share.token)).resolves.toMatchObject({
      plan: expect.objectContaining({ id: plan.id }),
      share: expect.objectContaining({ id: share.id }),
    });
    await expect(store.resolvePublicAccess('legacy-token')).resolves.toMatchObject({
      plan: expect.objectContaining({ id: plan.id }),
      share: expect.objectContaining({ id: share.id }),
      isLegacyToken: true,
    });

    await store.revokeShare(share.id);
    await expect(store.resolvePublicAccess('legacy-token')).resolves.toBeNull();
  });

  it('persists collaborator roles and marks stale active collaborators offline during cleanup', async () => {
    const plan = await store.createPlan('church-1', {
      title: 'Role Test',
      ownerKey: 'owner-session',
      ownerName: 'Taylor',
    });

    await store.upsertCollaborator(plan.id, 'church-1', {
      collaboratorKey: 'editor-session',
      displayName: 'Jordan',
      role: 'editor',
      status: 'active',
      joinedAt: Date.now() - 60000,
      lastSeenAt: Date.now() - 60000,
    });
    await store.upsertCollaborator(plan.id, 'church-1', {
      collaboratorKey: 'viewer-session',
      displayName: 'Sam',
      role: 'viewer',
      status: 'active',
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    await store.cleanupStaleCollaborators(Date.now() - 30_000);

    const collaborators = await store.getCollaborators(plan.id);
    expect(collaborators).toEqual(expect.arrayContaining([
      expect.objectContaining({ collaboratorKey: 'owner-session', role: 'owner' }),
      expect.objectContaining({ collaboratorKey: 'editor-session', role: 'editor', status: 'offline' }),
      expect.objectContaining({ collaboratorKey: 'viewer-session', role: 'viewer', status: 'active' }),
    ]));
  });
});
