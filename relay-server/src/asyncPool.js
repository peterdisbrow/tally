'use strict';

async function runWithConcurrency(items, limit, worker) {
  const queue = Array.isArray(items) ? items : Array.from(items || []);
  if (queue.length === 0) return;

  const concurrency = Math.max(1, Math.min(Number(limit) || 1, queue.length));
  let index = 0;

  async function runner() {
    while (index < queue.length) {
      const currentIndex = index++;
      await worker(queue[currentIndex], currentIndex);
    }
  }

  const runners = [];
  for (let i = 0; i < concurrency; i++) {
    runners.push(runner());
  }

  const results = await Promise.allSettled(runners);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

module.exports = {
  runWithConcurrency,
};
