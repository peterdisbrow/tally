/**
 * Rundown Timer Client — lightweight integration module for the TallyConnect
 * countdown timer feed. Designed for the clock app or any external display.
 *
 * Usage:
 *
 *   <script src="/tools/rundown-timer-client.js"></script>
 *   <script>
 *     var timer = connectRundownTimer('https://your-relay.tallyconnect.com', 'SHARE_TOKEN');
 *
 *     timer.on('update', function(state) {
 *       console.log(state.cue_title);        // "Worship Set"
 *       console.log(state.remaining_seconds); // 180
 *       console.log(state.is_overtime);       // false
 *       console.log(state.is_live);           // true
 *       console.log(state.next_cue_title);    // "Message"
 *     });
 *
 *     timer.on('ended', function() {
 *       console.log('Rundown session ended');
 *     });
 *
 *     timer.on('connection', function(connected) {
 *       console.log('WebSocket connected:', connected);
 *     });
 *
 *     // Later: timer.disconnect();
 *   </script>
 *
 * State object shape:
 *   {
 *     plan_id: string,
 *     plan_title: string,
 *     cue_title: string,
 *     cue_index: number,
 *     total_cues: number,
 *     cue_duration_seconds: number,
 *     elapsed_seconds: number,
 *     remaining_seconds: number | null,
 *     overtime_seconds: number,
 *     is_overtime: boolean,
 *     is_warning: boolean,
 *     is_live: boolean,
 *     next_cue_title: string | null,
 *     next_cue_duration: number | null,
 *     started_at: number,
 *     timestamp: number,
 *   }
 */

(function(global) {
  'use strict';

  function connectRundownTimer(serverUrl, shareToken, opts) {
    opts = opts || {};
    var roomId = opts.roomId || null;
    var reconnectMs = 1000;
    var maxReconnectMs = 10000;
    var ws = null;
    var reconnectTimer = null;
    var listeners = { update: [], ended: [], connection: [] };
    var destroyed = false;

    // Current state (readable)
    var currentState = {
      cue_title: '',
      remaining_seconds: null,
      is_overtime: false,
      is_live: false,
      is_warning: false,
      next_cue_title: null,
    };

    function emit(event, data) {
      var fns = listeners[event] || [];
      for (var i = 0; i < fns.length; i++) {
        try { fns[i](data); } catch(e) { console.error('[RundownTimer]', e); }
      }
    }

    function connect() {
      if (destroyed) return;
      if (ws) { try { ws.close(); } catch(e) {} }

      // Build WS URL
      var base = serverUrl.replace(/^http/, 'ws').replace(/\/$/, '');
      var url = base + '/rundown-timer?token=' + encodeURIComponent(shareToken);
      if (roomId) url += '&room=' + encodeURIComponent(roomId);

      ws = new WebSocket(url);

      ws.onopen = function() {
        reconnectMs = 1000;
        emit('connection', true);
        ws.send(JSON.stringify({ type: 'subscribe_timer', token: shareToken }));
      };

      ws.onmessage = function(evt) {
        try {
          var msg = JSON.parse(evt.data);
          if (msg.type === 'rundown_timer' || msg.type === 'timer_state') {
            currentState = msg;
            emit('update', msg);
          } else if (msg.type === 'rundown_ended') {
            currentState = { is_live: false, plan_title: msg.planTitle || msg.plan_title };
            emit('ended', currentState);
            emit('update', currentState);
          }
        } catch(e) {}
      };

      ws.onclose = function() {
        emit('connection', false);
        if (!destroyed) scheduleReconnect();
      };

      ws.onerror = function() {
        try { ws.close(); } catch(e) {}
      };
    }

    function scheduleReconnect() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(function() {
        connect();
      }, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 1.5, maxReconnectMs);
    }

    // Heartbeat
    var heartbeat = setInterval(function() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);

    // Public API
    var api = {
      on: function(event, fn) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
        return api;
      },

      off: function(event, fn) {
        var fns = listeners[event];
        if (fns) {
          listeners[event] = fns.filter(function(f) { return f !== fn; });
        }
        return api;
      },

      get state() { return currentState; },
      get currentCueTitle() { return currentState.cue_title || ''; },
      get remainingSeconds() { return currentState.remaining_seconds; },
      get isOvertime() { return !!currentState.is_overtime; },
      get isLive() { return !!currentState.is_live; },
      get isWarning() { return !!currentState.is_warning; },
      get nextCueTitle() { return currentState.next_cue_title || ''; },

      disconnect: function() {
        destroyed = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        clearInterval(heartbeat);
        if (ws) { try { ws.close(); } catch(e) {} }
        ws = null;
      },
    };

    // Start
    connect();
    return api;
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { connectRundownTimer: connectRundownTimer };
  } else {
    global.connectRundownTimer = connectRundownTimer;
  }

})(typeof window !== 'undefined' ? window : this);
