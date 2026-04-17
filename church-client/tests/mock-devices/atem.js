'use strict';

/**
 * MockAtem — UDP server (port 9910 by default)
 *
 * Implements just enough of the Blackmagic ATEM binary protocol to satisfy
 * the atem-connection library's initial SYN/SYNACK handshake, causing it to
 * advance to ConnectionState.Established.
 *
 * ATEM UDP packet header (12 bytes):
 *   [0]     flagsHi  — upper 5 bits = flags, lower 3 bits = size[10:8]
 *   [1]     sizeLo   — size[7:0]
 *   [2-3]   sessionId (big-endian)
 *   [4-5]   ackPacketId
 *   [6-7]   unknown
 *   [8-9]   unknown
 *   [10-11] remotePacketId
 *
 * PacketFlag (flags = byte[0] >> 3):
 *   AckRequest    = 1   (0x08 in byte[0])
 *   NewSessionId  = 2   (0x10 in byte[0])  ← SYN/SYNACK
 *   IsRetransmit  = 4
 *   RetransmitReq = 8
 *   AckReply      = 16  (0x80 in byte[0])
 *
 * Handshake sequence:
 *   Client → Server: 20-byte HELLO packet (byte[0]=0x10 → NewSessionId flag)
 *   Server → Client: 20-byte response (byte[0]=0x10 → NewSessionId flag, bytes[2-3]=sessionId)
 *   Client → Server: 12-byte ACK
 *
 * After the handshake the mock accepts AckRequest packets and replies with
 * a minimal AckReply so the client doesn't keep re-sending.
 *
 * Test interface:
 *   getProgramInput()  → number
 *   getPreviewInput()  → number
 *   setProgram(n)      — force a program change
 *   setPreview(n)      — force a preview change
 */

const dgram = require('dgram');
const { EventEmitter } = require('events');

// ATEM packet flags (value of byte[0] >> 3)
const PacketFlag = {
  AckRequest:    1,
  NewSessionId:  2,
  IsRetransmit:  4,
  RetransmitReq: 8,
  AckReply:      16,
};

let _sessionCounter = 0x1000;

class MockAtem extends EventEmitter {
  constructor() {
    super();
    this._socket   = null;
    this._sessions = new Map();  // sessionId → { rinfo, lastPacketId }
    this._program  = 1;
    this._preview  = 2;
  }

  /** The UDP port the server is bound to (available after start()). */
  get port() {
    return this._socket?.address()?.port ?? null;
  }

  /**
   * Start listening.
   * @param {number} [port=0]  0 = random available port
   * @returns {Promise<number>} bound port
   */
  async start(port = 0) {
    return new Promise((resolve, reject) => {
      this._socket = dgram.createSocket('udp4');
      this._socket.once('error', reject);
      this._socket.on('message', (msg, rinfo) => this._handlePacket(msg, rinfo));
      this._socket.bind(port, '127.0.0.1', () => {
        this._socket.removeListener('error', reject);
        resolve(this._socket.address().port);
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      if (!this._socket) return resolve();
      this._socket.close(() => resolve());
      this._socket = null;
    });
  }

  // ─── PACKET HANDLER ───────────────────────────────────────────────────────

  _handlePacket(msg, rinfo) {
    if (msg.length < 12) return;

    const headerWord = msg.readUInt16BE(0);
    const length     = headerWord & 0x07FF;
    const flags      = msg.readUInt8(0) >> 3;
    const sessionId  = msg.readUInt16BE(2);

    if (length !== msg.length) return;  // malformed

    // ── Client hello (SYN) ──────────────────────────────────────────────────
    if (flags & PacketFlag.NewSessionId) {
      const newSessionId = (_sessionCounter++ & 0x7FFF) | 0x8000;
      this._sessions.set(newSessionId, { rinfo, lastPacketId: 0 });
      this._sendSynAck(rinfo, newSessionId);
      this.emit('connected', { rinfo, sessionId: newSessionId });
      return;
    }

    const session = this._sessions.get(sessionId);
    if (!session) return;

    // ── AckRequest (data packet) ─────────────────────────────────────────────
    if (flags & PacketFlag.AckRequest) {
      const remotePacketId = msg.readUInt16BE(10);
      session.lastPacketId = remotePacketId;

      // Parse any commands in the payload (after 12-byte header)
      if (msg.length > 12) {
        this._parseCommands(msg.slice(12), session, rinfo);
      }

      this._sendAck(rinfo, sessionId, remotePacketId);
    }
  }

  /** Respond to a client SYN with a NewSessionId packet. */
  _sendSynAck(rinfo, sessionId) {
    const buf = Buffer.alloc(20, 0);
    // flags=NewSessionId(2) → byte[0] = 2 << 3 = 0x10; length=20 → 0x0014
    buf.writeUInt16BE(0x1014, 0);
    buf.writeUInt16BE(sessionId, 2);
    this._send(buf, rinfo);
  }

  /** Send an ACK reply for a given remote packet ID. */
  _sendAck(rinfo, sessionId, ackPacketId) {
    const buf = Buffer.alloc(12, 0);
    // flags=AckReply(16) → byte[0] = 16 << 3 = 0x80; length=12 → 0x000C
    buf.writeUInt16BE(0x800C, 0);
    buf.writeUInt16BE(sessionId, 2);
    buf.writeUInt16BE(ackPacketId, 4);
    this._send(buf, rinfo);
  }

  _send(buf, rinfo) {
    if (!this._socket) return;
    this._socket.send(buf, 0, buf.length, rinfo.port, rinfo.address);
  }

  // ─── COMMAND PARSING ──────────────────────────────────────────────────────

  /**
   * Parse ATEM command blocks from a packet payload.
   * Each command: 2-byte length, 2-byte unknown, 4-byte name, variable data.
   */
  _parseCommands(payload, session, rinfo) {
    let offset = 0;
    while (offset + 8 <= payload.length) {
      const cmdLen  = payload.readUInt16BE(offset);
      if (cmdLen < 8 || offset + cmdLen > payload.length) break;

      const cmdName = payload.slice(offset + 4, offset + 8).toString('ascii').replace(/\0/g, '');
      const cmdData = payload.slice(offset + 8, offset + cmdLen);

      switch (cmdName) {
        case 'CPgI': {  // Cut Program Input
          const input = cmdData.readUInt16BE(2);
          const me    = cmdData.readUInt8(0);
          this._program = input;
          this.emit('programChanged', { me, input });
          break;
        }
        case 'CPvI': {  // Cut Preview Input
          const input = cmdData.readUInt16BE(2);
          const me    = cmdData.readUInt8(0);
          this._preview = input;
          this.emit('previewChanged', { me, input });
          break;
        }
        case 'DCut': {  // Cut (take)
          this.emit('cut');
          break;
        }
        default:
          break;
      }

      offset += cmdLen;
    }
  }

  // ─── TEST INSPECTION API ──────────────────────────────────────────────────

  getProgramInput() { return this._program; }
  getPreviewInput() { return this._preview; }

  setProgram(input) {
    this._program = input;
    this.emit('programChanged', { me: 0, input });
  }

  setPreview(input) {
    this._preview = input;
    this.emit('previewChanged', { me: 0, input });
  }
}

module.exports = { MockAtem };
