const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { execSync } = require('child_process');

const { getSystemHealth, getCpuUsage, getMemoryInfo, getDiskInfo } = require('../src/systemHealth');

// ─── getMemoryInfo (live) ────────────────────────────────────────────────────

test('getMemoryInfo returns valid memory stats', () => {
  const mem = getMemoryInfo();
  assert.equal(typeof mem.total, 'number');
  assert.equal(typeof mem.used, 'number');
  assert.equal(typeof mem.free, 'number');
  assert.equal(typeof mem.usage, 'number');
  assert.ok(mem.total > 0, 'total memory should be > 0');
  assert.ok(mem.free >= 0, 'free memory should be >= 0');
  assert.ok(mem.used >= 0, 'used memory should be >= 0');
  assert.ok(mem.usage >= 0 && mem.usage <= 100, `usage should be 0-100, got ${mem.usage}`);
  assert.ok(Math.abs(mem.total - mem.used - mem.free) < 1024, 'total should equal used + free');
});

// ─── getDiskInfo (live) ──────────────────────────────────────────────────────

test('getDiskInfo returns valid disk stats', () => {
  const disk = getDiskInfo();
  assert.equal(typeof disk.total, 'number');
  assert.equal(typeof disk.used, 'number');
  assert.equal(typeof disk.free, 'number');
  assert.equal(typeof disk.usage, 'number');
  assert.ok(disk.total > 0, 'total disk should be > 0');
  assert.ok(disk.usage >= 0 && disk.usage <= 100, `disk usage should be 0-100, got ${disk.usage}`);
});

// ─── getCpuUsage (live) ──────────────────────────────────────────────────────

test('getCpuUsage returns usage and core count', async () => {
  const cpu = await getCpuUsage();
  assert.equal(typeof cpu.usage, 'number');
  assert.equal(typeof cpu.cores, 'number');
  assert.ok(cpu.cores > 0, 'should have at least 1 core');
  assert.ok(cpu.usage >= 0 && cpu.usage <= 100, `cpu usage should be 0-100, got ${cpu.usage}`);
});

// ─── getSystemHealth (live) ──────────────────────────────────────────────────

test('getSystemHealth returns full health object', async () => {
  const health = await getSystemHealth();
  assert.ok(health.cpu, 'should have cpu');
  assert.ok(health.memory, 'should have memory');
  assert.ok(health.disk, 'should have disk');
  assert.equal(typeof health.uptime, 'number');
  assert.ok(health.uptime >= 0, 'uptime should be >= 0');
  assert.ok(Array.isArray(health.warnings), 'warnings should be an array');
});

test('warnings array contains only strings', async () => {
  const health = await getSystemHealth();
  for (const w of health.warnings) {
    assert.equal(typeof w, 'string', 'each warning should be a string');
  }
});

// ─── Mocked getMemoryInfo for high memory usage ─────────────────────────────

test('getMemoryInfo reports high usage when free memory is low (mocked)', (t) => {
  const totalMem = 16 * 1024 * 1024 * 1024; // 16 GB
  const freeMem = 1 * 1024 * 1024 * 1024;   // 1 GB free => 93.75% usage
  t.mock.method(os, 'totalmem', () => totalMem);
  t.mock.method(os, 'freemem', () => freeMem);

  const mem = getMemoryInfo();
  assert.equal(mem.total, totalMem);
  assert.equal(mem.free, freeMem);
  assert.equal(mem.used, totalMem - freeMem);
  assert.ok(mem.usage > 90, `usage should be >90%, got ${mem.usage}`);
});

test('getMemoryInfo reports low usage when mostly free (mocked)', (t) => {
  const totalMem = 16 * 1024 * 1024 * 1024;
  const freeMem = 14 * 1024 * 1024 * 1024;  // 14 GB free => 12.5% usage
  t.mock.method(os, 'totalmem', () => totalMem);
  t.mock.method(os, 'freemem', () => freeMem);

  const mem = getMemoryInfo();
  assert.ok(mem.usage < 20, `usage should be <20%, got ${mem.usage}`);
});

test('getMemoryInfo rounds usage to one decimal place', (t) => {
  const totalMem = 3 * 1024 * 1024 * 1024;
  const freeMem = 1 * 1024 * 1024 * 1024;
  t.mock.method(os, 'totalmem', () => totalMem);
  t.mock.method(os, 'freemem', () => freeMem);

  const mem = getMemoryInfo();
  // usage = (2/3)*100 = 66.666...  rounded to 66.7
  assert.equal(mem.usage, 66.7);
});

// ─── Mocked getCpuUsage ─────────────────────────────────────────────────────

test('getCpuUsage returns 0% when all time is idle (mocked)', async (t) => {
  // Both calls return the same idle-heavy values; delta is all idle
  const cpuData = [
    { times: { user: 100, nice: 0, sys: 50, idle: 10000, irq: 0 } },
    { times: { user: 100, nice: 0, sys: 50, idle: 10000, irq: 0 } },
  ];
  t.mock.method(os, 'cpus', () => JSON.parse(JSON.stringify(cpuData)));

  const cpu = await getCpuUsage();
  // All deltas are 0, so totalTick is 0, returns 0
  assert.equal(cpu.usage, 0);
  assert.equal(cpu.cores, 2);
});

test('getCpuUsage returns high usage when CPU is busy (mocked)', async (t) => {
  let callCount = 0;
  t.mock.method(os, 'cpus', () => {
    callCount++;
    if (callCount === 1) {
      // First call (start)
      return [{ times: { user: 1000, nice: 0, sys: 500, idle: 8500, irq: 0 } }];
    }
    // Second call (end) — lots of user time added, very little idle
    return [{ times: { user: 1900, nice: 0, sys: 600, idle: 8510, irq: 0 } }];
  });

  const cpu = await getCpuUsage();
  // user delta=900, sys delta=100, idle delta=10 => total=1010, busy=1000
  // usage = (1000/1010)*100 = 99.0%
  assert.ok(cpu.usage > 95, `usage should be >95%, got ${cpu.usage}`);
  assert.equal(cpu.cores, 1);
});

// ─── getDiskInfo error handling ─────────────────────────────────────────────

test('getDiskInfo returns error object when execSync throws', (t) => {
  const cp = require('child_process');
  t.mock.method(cp, 'execSync', () => {
    throw new Error('command not found: df');
  });

  const disk = getDiskInfo();
  assert.equal(disk.total, 0);
  assert.equal(disk.used, 0);
  assert.equal(disk.free, 0);
  assert.equal(disk.usage, 0);
  assert.ok(disk.error, 'should have error field');
  assert.ok(disk.error.includes('command not found'), `error should mention cause, got: ${disk.error}`);
});

// ─── getDiskInfo Windows path (mocked) ──────────────────────────────────────

test('getDiskInfo parses Windows wmic output correctly (mocked)', (t) => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

  const cp = require('child_process');
  const wmicOutput = 'Node,FreeSpace,Size\nMYPC,53687091200,107374182400\n';
  t.mock.method(cp, 'execSync', () => wmicOutput);

  const disk = getDiskInfo();
  assert.equal(disk.free, 53687091200);
  assert.equal(disk.total, 107374182400);
  assert.equal(disk.used, 107374182400 - 53687091200);
  assert.equal(disk.usage, 50);

  // Restore platform
  if (origPlatform) {
    Object.defineProperty(process, 'platform', origPlatform);
  } else {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  }
});

test('getDiskInfo parses Unix df output correctly (mocked)', (t) => {
  const cp = require('child_process');
  // df -k / output: 1K-blocks Used Available Use% Mounted
  const dfOutput = 'Filesystem  1K-blocks    Used     Available Use% Mounted on\n/dev/sda1   100000000 80000000  20000000  80% /\n';
  t.mock.method(cp, 'execSync', () => dfOutput);

  const disk = getDiskInfo();
  assert.equal(disk.total, 100000000 * 1024);
  assert.equal(disk.used, 80000000 * 1024);
  assert.equal(disk.free, 20000000 * 1024);
  assert.equal(disk.usage, 80);
});

// ─── Warning thresholds with mocked system values ───────────────────────────

test('getSystemHealth generates CPU warning when usage > 85%', async (t) => {
  let cpuCallCount = 0;
  t.mock.method(os, 'cpus', () => {
    cpuCallCount++;
    if (cpuCallCount === 1) {
      return [{ times: { user: 1000, nice: 0, sys: 500, idle: 8500, irq: 0 } }];
    }
    // 95% busy: user+900, sys+100, idle+10
    return [{ times: { user: 1900, nice: 0, sys: 600, idle: 8510, irq: 0 } }];
  });

  const health = await getSystemHealth();
  assert.ok(health.cpu.usage > 85, `CPU usage should be >85%, got ${health.cpu.usage}`);
  assert.ok(health.warnings.some(w => w.includes('CPU')), 'should have CPU warning');
});

test('getSystemHealth generates memory warning when usage > 90%', async (t) => {
  t.mock.method(os, 'totalmem', () => 16 * 1024 * 1024 * 1024);
  t.mock.method(os, 'freemem', () => 1 * 1024 * 1024 * 1024); // 93.75%

  const health = await getSystemHealth();
  assert.ok(health.memory.usage > 90, `Memory usage should be >90%, got ${health.memory.usage}`);
  assert.ok(health.warnings.some(w => w.includes('Memory')), 'should have Memory warning');
});

test('getSystemHealth generates disk warning when usage > 90%', async (t) => {
  const cp = require('child_process');
  // Disk 95% used
  const dfOutput = 'Filesystem  1K-blocks    Used     Available Use% Mounted on\n/dev/sda1   100000000 95000000  5000000  95% /\n';
  t.mock.method(cp, 'execSync', () => dfOutput);

  const health = await getSystemHealth();
  assert.ok(health.disk.usage > 90, `Disk usage should be >90%, got ${health.disk.usage}`);
  assert.ok(health.warnings.some(w => w.includes('Disk')), 'should have Disk warning');
});

test('getSystemHealth generates no warnings when usage is low', async (t) => {
  // Low CPU: all idle
  t.mock.method(os, 'cpus', () => [{ times: { user: 100, nice: 0, sys: 50, idle: 10000, irq: 0 } }]);
  // Low memory
  t.mock.method(os, 'totalmem', () => 16 * 1024 * 1024 * 1024);
  t.mock.method(os, 'freemem', () => 12 * 1024 * 1024 * 1024); // 25%
  // Low disk
  const cp = require('child_process');
  const dfOutput = 'Filesystem  1K-blocks    Used     Available Use% Mounted on\n/dev/sda1   100000000 30000000  70000000  30% /\n';
  t.mock.method(cp, 'execSync', () => dfOutput);

  const health = await getSystemHealth();
  assert.deepEqual(health.warnings, [], 'should have no warnings when everything is low');
});

test('getSystemHealth uptime is non-negative integer', async () => {
  const health = await getSystemHealth();
  assert.ok(Number.isInteger(health.uptime), 'uptime should be integer');
  assert.ok(health.uptime >= 0);
});

test('getSystemHealth includes disk error field when disk command fails', async (t) => {
  const cp = require('child_process');
  t.mock.method(cp, 'execSync', () => {
    throw new Error('disk fail');
  });

  const health = await getSystemHealth();
  assert.ok(health.disk.error, 'disk should have error field');
  assert.equal(health.disk.usage, 0);
  // No disk warning because usage is 0
  assert.ok(!health.warnings.some(w => w.includes('Disk')));
});
