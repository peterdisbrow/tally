# Real Bitfocus Companion 5.0.6: HTTP API observations (lab instance, 25 Sep 02:51–03:00 ET)
My own throwaway instance (admin port 18000, config /tmp/tally-companion-lab, box user). It was stopped afterwards. Crewline's instances on 8000/8001 were not touched. The routes below come from main.js; the responses were observed with curl.

- `GET /api/variable/internal/time_hms/value` → 200 text/html body `02:51:55` ← **fingerprint for "this is Companion"**
- `GET /api/location/1/0/0` → **404** (no GET for buttons). The old driver's `isAvailable` counted 404 (<500) as up, so any web server passed as Companion.
- `GET /api/connections` → 200 JSON `[]` (5.x). Items are `{id,label,moduleId,enabled,status:{category:'good'|'warning'|'error'|null, level, message}|null}`. The old driver `String(status)` gives "[object Object]", so errors never show.
- `POST /api/location/P/R/C/press` → 200 `ok` when a button exists, **204 (empty) "No control"** when it doesn't. The old driver treats 204 as pressed.
- `POST /api/custom-variable/NAME/value?value=X` → 404 `Not found` if the variable doesn't exist. With a JSON body `{"value":"x"}`, Companion stores the **whole object** as the value. The old driver sends a JSON body.
- `GET /api/custom-variable/NAME/value` → 404 `Not found` / raw text.
- Module variables: the real path is `/api/variable/LABEL/NAME/value`. The old driver used `/api/LABEL/NAME/value` → 404 always.
- Unknown `/api/*` → 404 empty. `GET /` → 200 web UI HTML.
- The HTTP API can be disabled in settings (`http_api_enabled`): every /api route → **403**.
- Button text: internal variables `b_text_P_R_C`, `b_active_P_R_C` and `b_step_P_R_C` are set when a button is drawn (a nav button → 404, no text). Untested with a text button, because buttons can only be created through the UI/tRPC-WS.
- Default admin port in 4.x/5.x is 8000. The old code defaults to 8888 (Companion 2.x).

## Follow-up 03:04–03:07 ET (same lab instance on :18000, stopped afterwards)
- Buttons created over tRPC WS (`controls.resetControl {location:{pageNumber,row,column}, newType:'button-layered'}`; 5.x has no plain "button" type) and labelled with `controls.styles.updateOption {controlId, elementId:'text0', key:'text', value:{value,isExpression:false}}`.
- **`b_text_P_R_C` confirmed**: after labelling, `/api/variable/internal/b_text_1_1_1/value` → `Dante: Sunday`. A button with no label → 200 empty body; no button → 404. `b_step` → 1, `b_active` → false.
- `POST /api/location/P/R/C/style?text=…` answers 200 `ok` on a layered button in 5.0.6 **but does not change the text** (checked in db). Tally doesn't use it.
- Press on a real button → 200 `ok`; on an empty slot → 204.
- Custom variable created via tRPC `customVariables.create {name, defaultVal}`, then `POST …?value=green` → read back `green`.
- New driver run against this real instance: see `real-5.0.6-driver-check.txt` (all behaviours as intended: exact match, ambiguous refused, unique partial, empty slot refused, missing variable refused, offline and not-Companion detected).
- Not exercised live: a module connection in error/warning (no modules installed in the lab instance). The status shape comes from Companion's source.
