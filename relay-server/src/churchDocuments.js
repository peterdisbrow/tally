'use strict';

/**
 * churchDocuments.js
 * Persistent knowledge base for per-church document uploads.
 *
 * TDs upload SOPs, equipment guides, volunteer handbooks, etc.
 * Documents are chunked, summarized (one Haiku call), and stored in SQLite.
 * Retrieval is keyword-based (no vector DB) — returns the best-matching chunk
 * within a 400-char budget for injection into the AI parser context.
 */

const { v4: uuidv4 } = require('uuid');
const { createQueryClient } = require('./db');

const MAX_CHUNKS_PER_DOC = 20;
const CHUNK_SIZE = 500; // chars per chunk (paragraph boundary)
const MAX_SUMMARY_CHARS = 200;
const DOC_CONTEXT_BUDGET = 400; // max chars injected into AI context

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

class ChurchDocuments {
  /**
   * @param {object} dbOrClient
   * @param {object} [options]
   * @param {object} [options.config]
   */
  constructor(dbOrClient, options = {}) {
    this.db = dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null;
    this.client = this._resolveClient(dbOrClient, options);
    this._logAiUsage = null;
    this.ready = this.client ? this._init() : Promise.resolve();
  }

  _resolveClient(dbOrClient, options = {}) {
    if (!dbOrClient) return null;
    if (typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: options.config || SQLITE_FALLBACK_CONFIG,
      sqliteDb: dbOrClient,
    });
  }

  _requireClient() {
    if (!this.client) throw new Error('[ChurchDocuments] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureSchema();
  }

  async _ensureSchema() {
    const client = this._requireClient();
    await client.exec(`
      CREATE TABLE IF NOT EXISTS church_documents (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        doc_type TEXT DEFAULT 'general',
        summary TEXT NOT NULL,
        chunks TEXT DEFAULT '[]',
        uploaded_by TEXT,
        uploaded_at TEXT NOT NULL,
        active INTEGER DEFAULT 1
      )
    `);
    try {
      await client.exec('CREATE INDEX IF NOT EXISTS idx_docs_church ON church_documents(church_id, active)');
    } catch (err) { /* already exists */ console.debug("[churchDocuments] intentional swallow:", err); }
  }

  /**
   * Wire the AI usage logger (same pattern as ai-parser).
   */
  setAiUsageLogger(fn) { this._logAiUsage = fn; }

  // ─── UPLOAD PIPELINE ────────────────────────────────────────────────────────

  /**
   * Process and store a document upload.
   * @param {string} churchId
   * @param {string} base64Data  Base64-encoded file content
   * @param {string} fileName    Original filename
   * @param {string} mimeType    MIME type
   * @param {string} [uploaderName='TD']
   * @returns {Promise<{ id: string, summary: string, chunkCount: number }>}
   */
  async uploadDocument(churchId, base64Data, fileName, mimeType, uploaderName = 'TD') {
    await this.ready;
    // 1. Extract text based on MIME type
    let text;
    if (mimeType === 'text/plain' || mimeType === 'text/csv') {
      text = Buffer.from(base64Data, 'base64').toString('utf-8');
    } else if (mimeType === 'application/pdf' || (mimeType && mimeType.startsWith('image/'))) {
      text = await this._extractWithVision(base64Data, mimeType, churchId);
    } else {
      throw new Error(`Unsupported file type: ${mimeType}. Supported: PDF, TXT, CSV, images.`);
    }

    if (!text || text.trim().length < 10) {
      throw new Error('Could not extract meaningful text from this file.');
    }

    // 2. Chunk into ~500-char segments on paragraph boundaries
    const chunks = this._chunkText(text, CHUNK_SIZE).slice(0, MAX_CHUNKS_PER_DOC);

    // 3. Generate summary with one Haiku call
    const summary = await this._generateSummary(text.slice(0, 3000), fileName, churchId);

    // 4. Store in database
    const id = uuidv4();
    const docType = this._inferDocType(fileName, text);

    await this._requireClient().run(
      `INSERT INTO church_documents (id, church_id, filename, doc_type, summary, chunks, uploaded_by, uploaded_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, churchId, fileName, docType, summary, JSON.stringify(chunks), uploaderName, new Date().toISOString()]
    );

    return { id, summary, chunkCount: chunks.length };
  }

  // ─── TEXT EXTRACTION ────────────────────────────────────────────────────────

  /**
   * Extract text from images or PDFs using Claude Haiku vision.
   */
  async _extractWithVision(base64Data, mimeType, churchId) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    // For PDFs, use image/* media type (Anthropic handles base64 PDFs via document type)
    const mediaType = mimeType === 'application/pdf' ? 'application/pdf' : mimeType;
    const sourceType = mimeType === 'application/pdf' ? 'base64' : 'base64';
    const contentBlock = mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } };

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          messages: [{
            role: 'user',
            content: [
              contentBlock,
              { type: 'text', text: 'Extract ALL text from this document. Return only the raw text content, no commentary.' },
            ],
          }],
          temperature: 0,
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 200)}`);
      }

      const data = await resp.json();

      // Log AI usage
      if (this._logAiUsage && data.usage) {
        this._logAiUsage({
          churchId,
          feature: 'document_extract',
          model: 'claude-haiku-4-5-20251001',
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        });
      }

      return data.content?.[0]?.text || '';
    } catch (e) {
      console.error('[ChurchDocuments] Vision extraction error:', e.message);
      throw new Error(`Text extraction failed: ${e.message}`);
    }
  }

  /**
   * Generate a concise summary for the document.
   */
  async _generateSummary(text, fileName, churchId) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return fileName; // Fallback to filename

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          messages: [{
            role: 'user',
            content: `Summarize this church AV production document in 20 words or fewer. Focus on what it covers and when it's useful.\n\nFilename: ${fileName}\n\nContent:\n${text}`,
          }],
          temperature: 0.2,
          max_tokens: 100,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) return fileName;
      const data = await resp.json();

      if (this._logAiUsage && data.usage) {
        this._logAiUsage({
          churchId,
          feature: 'document_summary',
          model: 'claude-haiku-4-5-20251001',
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        });
      }

      const summary = (data.content?.[0]?.text || fileName).slice(0, MAX_SUMMARY_CHARS);
      return summary;
    } catch {
      return fileName;
    }
  }

  // ─── TEXT CHUNKING ──────────────────────────────────────────────────────────

  /**
   * Split text into chunks on paragraph boundaries.
   */
  _chunkText(text, maxLen) {
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    let current = '';

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      if (current.length + trimmed.length + 1 > maxLen && current.length > 0) {
        chunks.push(current.trim());
        current = '';
      }

      if (trimmed.length > maxLen) {
        // Split long paragraphs on sentence boundaries
        if (current) { chunks.push(current.trim()); current = ''; }
        const sentences = trimmed.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 > maxLen && current.length > 0) {
            chunks.push(current.trim());
            current = '';
          }
          current += (current ? ' ' : '') + sentence;
        }
      } else {
        current += (current ? '\n\n' : '') + trimmed;
      }
    }

    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  /**
   * Infer document type from filename and content.
   */
  _inferDocType(fileName, text) {
    const lower = (fileName + ' ' + text.slice(0, 200)).toLowerCase();
    if (/sop|standard operating|procedure/.test(lower)) return 'sop';
    if (/guide|handbook|manual|training/.test(lower)) return 'guide';
    if (/note|log|meeting/.test(lower)) return 'notes';
    if (/inventory|equipment list|gear/.test(lower)) return 'inventory';
    return 'general';
  }

  // ─── RETRIEVAL ──────────────────────────────────────────────────────────────

  /**
   * Get the most relevant document chunk for a given query.
   * Simple keyword matching — no vector DB needed for typical church doc volumes.
   * @param {string} churchId
   * @param {string} query  The user's message
   * @returns {string}  Best matching chunk text (max DOC_CONTEXT_BUDGET chars), or empty
   */
  async getDocumentContext(churchId, query) {
    await this.ready;
    try {
      const docs = await this._requireClient().query(
        'SELECT chunks FROM church_documents WHERE church_id = ? AND active = 1',
        [churchId]
      );

      if (!docs.length) return '';

      const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (!queryWords.length) return '';

      let bestChunk = '';
      let bestScore = 0;

      for (const doc of docs) {
        let chunks;
        try { chunks = JSON.parse(doc.chunks || '[]'); } catch { continue; }
        for (const chunk of chunks) {
          const lower = chunk.toLowerCase();
          const score = queryWords.filter(w => lower.includes(w)).length;
          if (score > bestScore) {
            bestScore = score;
            bestChunk = chunk;
          }
        }
      }

      // Only return if at least 2 query words matched (avoid false positives)
      if (bestScore < 2) return '';
      return bestChunk.slice(0, DOC_CONTEXT_BUDGET);
    } catch (e) {
      console.error(`[ChurchDocuments] Context retrieval error:`, e.message);
      return '';
    }
  }

  // ─── LIST / DELETE ──────────────────────────────────────────────────────────

  /**
   * List all active documents for a church.
   */
  async listDocuments(churchId) {
    await this.ready;
    return this._requireClient().query(
      'SELECT id, filename, doc_type, summary, uploaded_by, uploaded_at FROM church_documents WHERE church_id = ? AND active = 1 ORDER BY uploaded_at DESC',
      [churchId]
    );
  }

  /**
   * Soft-delete a document.
   */
  async deleteDocument(churchId, docId) {
    await this.ready;
    return this._requireClient().run(
      'UPDATE church_documents SET active = 0 WHERE id = ? AND church_id = ?',
      [docId, churchId]
    );
  }
}

module.exports = { ChurchDocuments };
