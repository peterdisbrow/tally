# Planning Center pass: plan (drafted 03:50 ET 25 Sep, not started)
Planning Center is a relay/cloud integration, not a booth device:
- relay-server/src/planningCenter.js (2100 lines), routes/planningCenter.js, liveRundown.js
- Electron only has Connect/Disconnect (OAuth via relay).
- PC_API_BASE is hard-coded to https://api.planningcenteronline.com/services/v2 (15 uses) → needs a PCO_API_BASE override so the lab can point at a mock. Never call the real PCO API from tests.
- The existing church-client/test/mocks/planningCenterServer.js (199 lines) needs checking against the real JSON:API: auth 401, 403 scope, 404 plan, 429 + Retry-After, links.next pagination, include=items.

To verify from the official docs (developer.planning.center is a JS app, so use its JSON source or the pco-api docs repo):
- plans/items/plan_times shapes; the Services Live endpoints (live, go_to_next_item, go_to_previous_item, toggle_control); what a PAT vs OAuth scope can write (notes, plan times).

Relay commands and writebacks to test end to end with refusals: sync, next-service, plan detail, pp-check, pushSessionRecap, updateServiceTimes, syncVolunteerAttendance, writeServiceNotes. Cases: token revoked (401), no permission (403), plan deleted (404), rate-limited (429), PCO down (5xx or timeout).
