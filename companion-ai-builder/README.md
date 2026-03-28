# Companion AI Builder (MVP)

Standalone app that converts plain-English control goals into an exportable Companion layout spec.

## What this MVP does

- Accepts a freeform prompt (example: "Stream Deck XL M/E2 control surface with feedback").
- Parses intent and selects a matching layout template.
- Validates actions/feedback against selected gear capabilities.
- Renders a visual page preview in-browser.
- Probes a live Companion endpoint for health + installed connection modules.
- Runs compatibility checks between generated controls and Companion module families.
- Runs a deployment dry-run that checks target button slots for existence/occupancy.
- Exports:
  - `*.layout.json` (generator-native layout spec)
  - `*.plan.md` (human-readable implementation plan)
  - `*.companion-bundle.json` (deployment mapping bundle)
  - `*.deploy.md` (dry-run report)

## What this MVP does not do yet

- Directly write Companion project files.
- Apply a live layout mutation through Companion API (bundle/report export only).
- Module-version-specific action parameter remapping.

## Run

```bash
cd /Users/peter/openclaw/workspace/church-av/companion-ai-builder
npm install
npm start
```

Open: http://localhost:4177

## Test

```bash
npm test
```

## Architecture

- `src/engine/parser.js`: intent extraction from natural language
- `src/engine/templates.js`: layout templates (ATEM M/E1, M/E2, generic)
- `src/engine/capabilities.js`: deck models + gear action/feedback matrix
- `src/engine/validator.js`: capability checks and warning generation
- `src/engine/compatibility.js`: Companion module compatibility analysis
- `src/engine/generator.js`: orchestrates parse -> generate -> validate
- `src/adapters/companionAdapter.js`: live Companion HTTP probing
- `src/server.js`: API + static UI (`/api/generate`, `/api/export`, `/api/compatibility`, `/api/deploy`)

## Next steps for productization

1. Add module version detection + action ID remapping.
2. Add true Companion import/export schema support.
3. Add dry-run tester against live Companion connections.
4. Add multi-page optimization and conflict-aware key assignment.
5. Add guardrail policy engine for destructive controls.
