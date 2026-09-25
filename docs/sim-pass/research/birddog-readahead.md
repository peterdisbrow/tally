# BirdDog read-ahead (05:20 ET 25 Sep, not started — next device after the g6 milestone)
Driver: church-client/src/encoders/birddog.js (198 lines, wraps NdiEncoder), mock test/mocks/birddogServer.js (109 lines).
Official source: BirdDog RESTful API 2.0 (https://birddog.tv/AV/API/) + Postman collection for X-series cameras
(https://documenter.getpostman.com/view/29602224/2sAYHxn45i). All calls HTTP on port 8080, no auth.
- GET /about → JSON {FirmwareVersion, Format, HostName, IPAddress, NetworkConfigMethod, NetworkMask, SerialNumber, Status: ONLINE|OFFLINE|CAMERA INITIALIZING|NO VIDEO}
- GET /operationmode → text "encode"|"decode" (not on Flex/WP/P200/P100/P4k)
- GET /List → active NDI sources (JSON)
- The driver probes '/about', '/version', '/List' — '/version' is not in the API table (check). 'Status' NO VIDEO / OFFLINE must surface on the card.
- Model matrix matters: many endpoints are N/A per model → refuse honestly.
To do: conformance fixture from the API table; stateful mock with Status transitions + per-model N/A (404); red-first tests; booth pass; relay commands (encoder.*).
