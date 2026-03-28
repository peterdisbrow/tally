'use strict';

function validateLayout(layout, capabilities) {
  const warnings = [];
  const errors = [];

  for (const page of layout.pages) {
    for (const button of page.buttons) {
      const actionId = button.action?.id;
      if (!actionId) {
        errors.push(`Button "${button.label}" missing action id`);
        continue;
      }

      // Internal builder actions are allowed without gear.
      if (actionId.startsWith('builder.')) continue;
      if (!capabilities.actions.has(actionId)) {
        warnings.push(`Action not currently supported by selected gear: ${actionId} (button "${button.label}")`);
      }

      for (const fb of button.feedback || []) {
        if (!capabilities.feedback.has(fb.id)) {
          warnings.push(`Feedback not currently supported by selected gear: ${fb.id} (button "${button.label}")`);
        }
      }
    }
  }

  return { warnings, errors };
}

module.exports = { validateLayout };
