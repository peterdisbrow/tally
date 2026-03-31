/**
 * Switcher — Abstract base class for video switcher integrations.
 *
 * ATEM, OBS, and vMix each extend this class with their own connection
 * and switching logic.  The common interface lets SwitcherManager treat
 * every switcher uniformly for status reporting, tally, and failover.
 */

const EventEmitter = require('events');

/** Allowed role values for a switcher instance. */
const SWITCHER_ROLES = ['primary', 'backup', 'imag', 'broadcast', 'recording'];
const DEFAULT_ROLE = 'primary';

class Switcher extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.id        Unique ID (e.g. "atem-1", "obs-1")
   * @param {string} opts.type      "atem" | "obs" | "vmix"
   * @param {string} [opts.role]    User-configurable role (default: "primary")
   * @param {string} [opts.name]    Human-friendly label
   */
  constructor({ id, type, role, name } = {}) {
    super();
    if (!id) throw new Error('Switcher requires an id');
    if (!type) throw new Error('Switcher requires a type');
    this.id = id;
    this.type = type;
    this.role = SWITCHER_ROLES.includes(role) ? role : DEFAULT_ROLE;
    this.name = name || id;
    this.connected = false;
  }

  // ─── Lifecycle (override in subclass) ──────────────────────────────────────

  /** Connect to the switcher hardware/software. */
  async connect() { throw new Error(`${this.type}: connect() not implemented`); }

  /** Gracefully disconnect. */
  async disconnect() { throw new Error(`${this.type}: disconnect() not implemented`); }

  // ─── Switching operations (override in subclass) ───────────────────────────

  /** Cut to program. */
  async cut(me = 0) { throw new Error(`${this.type}: cut() not implemented`); }

  /** Set program input (hard cut, no transition). */
  async setProgram(input, me = 0) { throw new Error(`${this.type}: setProgram() not implemented`); }

  /** Set preview input. */
  async setPreview(input, me = 0) { throw new Error(`${this.type}: setPreview() not implemented`); }

  /** Auto-transition (mix/wipe/etc.) */
  async autoTransition(me = 0) { throw new Error(`${this.type}: autoTransition() not implemented`); }

  // ─── Status ────────────────────────────────────────────────────────────────

  /**
   * Return a plain status object for this switcher.
   * Subclasses should override and spread super.getStatus().
   */
  getStatus() {
    return {
      id: this.id,
      type: this.type,
      role: this.role,
      name: this.name,
      connected: this.connected,
      programInput: null,
      previewInput: null,
      inputLabels: {},
      recording: false,
      streaming: false,
      inTransition: false,
    };
  }

  /**
   * Return tally map: { inputId: "program" | "preview" | null }.
   * Default implementation derives tally from programInput/previewInput.
   */
  getTally() {
    const status = this.getStatus();
    const tally = {};
    if (status.programInput != null) tally[status.programInput] = 'program';
    if (status.previewInput != null && status.previewInput !== status.programInput) {
      tally[status.previewInput] = 'preview';
    }
    return tally;
  }
}

module.exports = { Switcher, SWITCHER_ROLES, DEFAULT_ROLE };
