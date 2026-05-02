/**
 * Scenario A: ProPresenter advances through slides → relay sees the updates.
 *
 * Flow:
 *   1. Seed a known presentation on the PP mock.
 *   2. Wait for the church-client agent's PP poller (2s) to publish status.
 *   3. Drive `advanceSlide` 3 times via mock control API.
 *   4. Assert the SSE stream reports slideIndex incrementing.
 */

'use strict';

module.exports = async function propresenterSlide(ctx) {
  const { mocks, sse } = ctx;

  // Seed a presentation with 20 slides, starting at index 0.
  await mocks.action('propresenter', 'setSlide', {
    presentationName: 'E2E Sermon',
    slideIndex: 0,
    slideTotal: 20,
  });

  // Wait for the agent to pick up the initial state. Real SSE shape
  // (verified by probe — see /tmp/sse-shape.json):
  //   s.proPresenter.currentSlide        ← string (presentation NAME)
  //   s.proPresenter.slideIndex          ← top-level on proPresenter
  //   s.proPresenter.slideTotal          ← top-level
  //   s.proPresenter.presentationUUID    ← top-level
  // The PP bridge polls every 2s; allow 8s for at least one cycle.
  await sse.waitFor(
    (s) => s?.proPresenter?.currentSlide === 'E2E Sermon',
    { timeoutMs: 10_000 },
  );

  // Advance 3 times via control API. The mock advances slideIndex on the
  // GET-style trigger fetch issued by the church-client's _fire().
  for (let i = 0; i < 3; i++) {
    await mocks.action('propresenter', 'advanceSlide');
    await new Promise((r) => setTimeout(r, 50));
  }

  // Wait until the relay reflects slideIndex >= 3.
  const final = await sse.waitFor(
    (s) => typeof s?.proPresenter?.slideIndex === 'number' && s.proPresenter.slideIndex >= 3,
    { timeoutMs: 10_000 },
  );

  // Cross-check with the mock — they should agree.
  const mockState = await mocks.state('propresenter');
  const mockIdx = mockState.slide?.slideIndex;
  if (typeof mockIdx !== 'number' || mockIdx < 3) {
    throw new Error(`Mock slideIndex=${mockIdx}, expected >=3 after 3 advances`);
  }
  ctx.log.debug(`PP final slideIndex (relay)=${final?.proPresenter?.slideIndex} (mock)=${mockIdx}`);
};
