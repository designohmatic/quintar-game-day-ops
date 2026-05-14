'use strict';

const path = require('path');
const fs   = require('fs');

let _template = null;

function loadTemplate() {
  if (_template) return _template;
  const p = path.resolve(__dirname, '../template.json');
  _template = JSON.parse(fs.readFileSync(p, 'utf8'));
  return _template;
}

/**
 * Materialize the canonical template into per-step runtime rows for a new game.
 * ownerOverrides: { [stepId]: string[] } — per-event owner overrides from the create request.
 * Returns a flat array of step objects ready to be inserted into step_states.
 */
function materializeSteps(ownerOverrides = {}) {
  const tpl = loadTemplate();
  const steps = [];
  for (const phase of tpl.phases) {
    for (const ts of phase.steps) {
      const owners = ownerOverrides[ts.stepId] || ts.owners.slice();
      steps.push({
        stepId:        ts.stepId,
        seq:           ts.seq,
        phase:         phase.phase,
        trackKey:      phase.trackKey || null,
        prefix:        phase.prefix   || null,
        name:          ts.name,
        cat:           ts.cat         || null,
        input:         ts.input       || null,
        output:        ts.output      || null,
        note:          ts.note        || null,
        owners,
        defaultOwners: ts.owners.slice(),
        status:        'pending',
        activatedAt:   null,
        completedAt:   null,
        actor:         null,
      });
    }
  }
  return steps;
}

module.exports = { loadTemplate, materializeSteps };
