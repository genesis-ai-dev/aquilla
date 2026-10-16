/**
 * PIDs in LISTENING state for one TCP port, parsed from `netstat -ano -p tcp`.
 * Windows has no lsof, which is what the e2e port cleanup used to call.
 */
export function pidsFromNetstat(output: string, port: number): string[] {
  const pids = new Set<string>()
  const portText = String(port)
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5 || parts[0] !== "TCP" || parts[3] !== "LISTENING") continue
    const local = parts[1] ?? ""
    const localPort = local.slice(local.lastIndexOf(":") + 1)
    if (localPort !== portText) continue
    const pid = parts[4]
    if (pid && pid !== "0") pids.add(pid)
  }
  return [...pids]
}
