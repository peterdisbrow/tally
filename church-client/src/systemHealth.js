/**
 * systemHealth.js — Host machine monitoring (CPU, RAM, disk)
 * Provides periodic snapshots of system resource usage for the church-client agent.
 */

const os = require('os');
const child_process = require('child_process');

/**
 * Compute CPU usage by sampling os.cpus() over a 1-second window.
 * Returns { usage: percent, cores: number }.
 */
function getCpuUsage() {
  return new Promise((resolve) => {
    const startCpus = os.cpus();

    setTimeout(() => {
      const endCpus = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;

      for (let i = 0; i < endCpus.length; i++) {
        const startTimes = startCpus[i] ? startCpus[i].times : endCpus[i].times;
        const endTimes = endCpus[i].times;

        const idleDelta = endTimes.idle - startTimes.idle;
        const totalDelta =
          (endTimes.user - startTimes.user) +
          (endTimes.nice - startTimes.nice) +
          (endTimes.sys - startTimes.sys) +
          (endTimes.idle - startTimes.idle) +
          (endTimes.irq - startTimes.irq);

        totalIdle += idleDelta;
        totalTick += totalDelta;
      }

      const usage = totalTick > 0
        ? Math.round((1 - totalIdle / totalTick) * 100 * 10) / 10
        : 0;

      resolve({ usage, cores: endCpus.length });
    }, 1000);
  });
}

/**
 * Get memory stats from the OS.
 */
function getMemoryInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const usage = Math.round((used / total) * 100 * 10) / 10;
  return { total, used, free, usage };
}

/**
 * Get disk usage for the root filesystem.
 * Cross-platform: df on Unix/macOS, wmic on Windows.
 */
function getDiskInfo() {
  try {
    if (process.platform === 'win32') {
      const raw = child_process.execSync('wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace /format:csv', {
        encoding: 'utf8',
        timeout: 5000,
      });
      const lines = raw.trim().split('\n').filter(l => l.trim());
      // Last line has: Node,FreeSpace,Size
      const parts = lines[lines.length - 1].split(',');
      const free = parseInt(parts[1], 10);
      const total = parseInt(parts[2], 10);
      const used = total - free;
      const usage = Math.round((used / total) * 100 * 10) / 10;
      return { total, used, free, usage };
    } else {
      const raw = child_process.execSync('df -k /', { encoding: 'utf8', timeout: 5000 });
      const lines = raw.trim().split('\n');
      // Second line has the data; columns: Filesystem 1K-blocks Used Available Use% Mounted
      if (lines.length < 2) return { total: 0, used: 0, free: 0, usage: 0, error: 'df returned no data' };
      const parts = lines[1].split(/\s+/);
      const total = parseInt(parts[1], 10) * 1024;
      const used = parseInt(parts[2], 10) * 1024;
      const free = parseInt(parts[3], 10) * 1024;
      const usage = Math.round((used / total) * 100 * 10) / 10;
      return { total, used, free, usage };
    }
  } catch (err) {
    return { total: 0, used: 0, free: 0, usage: 0, error: err.message };
  }
}

/**
 * Main entry point: collect all system health metrics.
 * Returns { cpu, memory, disk, uptime, warnings }.
 */
async function getSystemHealth() {
  const cpu = await getCpuUsage();
  const memory = getMemoryInfo();
  const disk = getDiskInfo();
  const uptime = Math.floor(os.uptime());
  const warnings = [];

  if (cpu.usage > 85) {
    warnings.push(`CPU usage high: ${cpu.usage}%`);
  }
  if (memory.usage > 90) {
    warnings.push(`Memory usage high: ${memory.usage}%`);
  }
  if (disk.usage > 90) {
    warnings.push(`Disk usage high: ${disk.usage}%`);
  }

  return { cpu, memory, disk, uptime, warnings };
}

module.exports = { getSystemHealth, getCpuUsage, getMemoryInfo, getDiskInfo };
