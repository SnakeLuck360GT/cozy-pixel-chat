// How the server itself is doing, for the admin page: CPU, load, memory,
// disk, network and uptime. CPU and network are rates, so they're worked
// out from samples taken every couple of seconds.

import { readFile, statfs } from "node:fs/promises";
import os from "node:os";

const SAMPLE_MS = 2000;
let previous = null;
let rates = { cpu: null, inBps: null, outBps: null };

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

// Bytes in and out on every network interface except loopback (Linux only).
async function networkBytes() {
  try {
    let rx = 0;
    let tx = 0;
    for (const line of (await readFile("/proc/net/dev", "utf8")).split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!rest || name.trim() === "lo") continue;
      const fields = rest.trim().split(/\s+/).map(Number);
      rx += fields[0];
      tx += fields[8];
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

async function sample() {
  const now = { at: Date.now(), cpu: cpuTimes(), net: await networkBytes() };
  if (previous) {
    const seconds = (now.at - previous.at) / 1000;
    const total = now.cpu.total - previous.cpu.total;
    rates = {
      cpu: total > 0 ? Math.round((1 - (now.cpu.idle - previous.cpu.idle) / total) * 100) : null,
      inBps: now.net && previous.net ? Math.round((now.net.rx - previous.net.rx) / seconds) : null,
      outBps: now.net && previous.net ? Math.round((now.net.tx - previous.net.tx) / seconds) : null,
    };
  }
  previous = now;
}

export function startSampling() {
  sample();
  setInterval(sample, SAMPLE_MS).unref();
}

// "Available" memory counts the disk cache the system can hand back, which
// is what matters; plain "free" makes Linux look full all the time.
async function memory() {
  try {
    const info = await readFile("/proc/meminfo", "utf8");
    const kb = (key) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0) * 1024;
    return { total: kb("MemTotal"), available: kb("MemAvailable") };
  } catch {
    return { total: os.totalmem(), available: os.freemem() };
  }
}

export async function systemStats(dir) {
  const [mem, disk] = await Promise.all([memory(), statfs(dir)]);
  return {
    cpu: rates.cpu,
    cores: os.cpus().length,
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memory: { total: mem.total, used: mem.total - mem.available },
    disk: { total: disk.blocks * disk.bsize, used: (disk.blocks - disk.bavail) * disk.bsize },
    network: { inBps: rates.inBps, outBps: rates.outBps },
    uptime: Math.round(os.uptime()),
    app: { memory: process.memoryUsage().rss, uptime: Math.round(process.uptime()) },
  };
}
