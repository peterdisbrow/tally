function buildStatusPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tally Status</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: radial-gradient(circle at top, #0f1b12 0%, #09090b 55%);
      color: #f8fafc;
      min-height: 100vh;
      padding: 24px;
    }
    .wrap { max-width: 980px; margin: 0 auto; }
    .hero {
      border: 1px solid #1f3b28;
      background: rgba(15, 22, 19, 0.9);
      border-radius: 14px;
      padding: 18px 20px;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .title { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
    .sub { color: #94a3b8; font-size: 13px; margin-top: 4px; }
    .badge {
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid #294538;
      background: #0e1b13;
      color: #22c55e;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .card {
      border: 1px solid #1f3b28;
      border-radius: 12px;
      padding: 14px;
      background: rgba(15, 22, 19, 0.88);
    }
    .c-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 15px;
      font-weight: 600;
    }
    .c-state {
      font-size: 12px;
      font-weight: 700;
      border-radius: 999px;
      padding: 3px 8px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .s-operational { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
    .s-degraded { background: rgba(234, 179, 8, 0.2); color: #facc15; }
    .s-outage { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .c-meta { color: #94a3b8; font-size: 12px; line-height: 1.5; }
    .table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #1f3b28;
      border-radius: 12px;
      overflow: hidden;
      background: rgba(15, 22, 19, 0.88);
    }
    .table th, .table td {
      text-align: left;
      padding: 10px 12px;
      font-size: 13px;
      border-bottom: 1px solid #16241a;
      vertical-align: top;
    }
    .table th { color: #94a3b8; font-weight: 600; }
    .muted { color: #94a3b8; }
    .empty {
      border: 1px dashed #264133;
      border-radius: 12px;
      padding: 16px;
      text-align: center;
      color: #94a3b8;
      background: rgba(15, 22, 19, 0.65);
    }
    a { color: #22c55e; text-decoration: none; }
    @media (max-width: 700px) {
      body { padding: 16px; }
      .title { font-size: 22px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div>
        <div class="title">Tally Platform Status</div>
        <div class="sub" id="updatedAt">Checking now...</div>
      </div>
      <div class="badge" id="overallState">OPERATIONAL</div>
    </div>

    <div class="grid" id="componentsGrid"></div>

    <table class="table" id="incidentsTable" style="display:none">
      <thead>
        <tr>
          <th>Time</th>
          <th>Component</th>
          <th>Transition</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody id="incidentsBody"></tbody>
    </table>
    <div class="empty" id="incidentsEmpty">No recent incidents.</div>

    <p class="sub" style="margin-top:14px">
      Need help? Visit the <a href="/church-portal">Church Portal</a> support tab.
    </p>
  </div>

  <script>
    function fmt(ts) {
      if (!ts) return '—';
      var d = new Date(ts);
      return d.toLocaleString();
    }

    function stateRank(state) {
      if (state === 'outage') return 3;
      if (state === 'degraded') return 2;
      return 1;
    }

    async function loadStatus() {
      try {
        var [componentsResp, incidentsResp] = await Promise.all([
          fetch('/api/status/components', { signal: AbortSignal.timeout(10000) }),
          fetch('/api/status/incidents?limit=20', { signal: AbortSignal.timeout(10000) }),
        ]);
        var componentsJson = await componentsResp.json();
        var incidents = await incidentsResp.json();

        var components = componentsJson.components || [];
        var updatedAt = componentsJson.updatedAt;

        var worst = 'operational';
        for (var i = 0; i < components.length; i++) {
          if (stateRank(components[i].state) > stateRank(worst)) worst = components[i].state;
        }

        var badge = document.getElementById('overallState');
        badge.textContent = worst.toUpperCase();
        badge.className = 'badge';
        if (worst === 'degraded') badge.style.color = '#facc15';
        else if (worst === 'outage') badge.style.color = '#f87171';
        else badge.style.color = '#22c55e';

        document.getElementById('updatedAt').textContent = 'Last checked: ' + fmt(updatedAt);

        var grid = document.getElementById('componentsGrid');
        grid.innerHTML = '';
        components.forEach(function(c) {
          var card = document.createElement('div');
          card.className = 'card';
          card.innerHTML =
            '<div class="c-title">' +
              '<span>' + c.name + '</span>' +
              '<span class="c-state s-' + c.state + '">' + c.state + '</span>' +
            '</div>' +
            '<div class="c-meta">' +
              (c.detail || 'No detail') + '<br/>' +
              'Latency: ' + (c.latency_ms == null ? '—' : c.latency_ms + ' ms') + '<br/>' +
              'Changed: ' + fmt(c.last_changed_at) +
            '</div>';
          grid.appendChild(card);
        });

        var table = document.getElementById('incidentsTable');
        var empty = document.getElementById('incidentsEmpty');
        var body = document.getElementById('incidentsBody');
        body.innerHTML = '';

        if (!incidents || incidents.length === 0) {
          table.style.display = 'none';
          empty.style.display = 'block';
        } else {
          table.style.display = 'table';
          empty.style.display = 'none';
          incidents.forEach(function(i) {
            var tr = document.createElement('tr');
            tr.innerHTML =
              '<td>' + fmt(i.started_at) + '</td>' +
              '<td>' + i.component_id + '</td>' +
              '<td>' + i.previous_state + ' → ' + i.new_state + '</td>' +
              '<td>' + (i.message || '') + (i.resolved_at ? '<br/><span class="muted">Resolved: ' + fmt(i.resolved_at) + '</span>' : '') + '</td>';
            body.appendChild(tr);
          });
        }
      } catch (err) {
        document.getElementById('componentsGrid').innerHTML = '<div class="empty">Failed to load status.</div>';
      }
    }

    loadStatus();
    setInterval(loadStatus, 60000);
  </script>
</body>
</html>`;
}

function setupStatusPage(app) {
  app.get('/status', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildStatusPageHtml());
  });
}

module.exports = { setupStatusPage };
