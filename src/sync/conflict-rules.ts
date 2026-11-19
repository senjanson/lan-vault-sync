import type { FileMeta } from "../types";
import { isTime } from "./agreed-versions";

/** What decides a file changed on two devices; see decideConflict. */
export interface ConflictFacts {
  local: FileMeta;
  remote: FileMeta;
  /** This device's ID and the peer's, to break a tie in time. */
  deviceId: string;
  remoteDeviceId: string;
  /** The version this device last had in common with the peer, if known. */
  agreed?: string;
  /** Hash of a deleted copy this device made a new file in place of. */
  revivedHash?: string;
}

/**
 * Whether the local version wins over the peer's, by when each was made:
 * the later one wins, and on a tie the device with the lower ID, so that
 * both devices decide alike.
 */
export function localIsWinner(localTime: number, remoteTime: number, deviceId: string, remoteDeviceId: string): boolean {
  if (localTime !== remoteTime) return localTime > remoteTime;
  return deviceId < remoteDeviceId;
}

/**
 * Which copy of a file to keep when the copies here and on the peer differ
 * and may not share a history, so that a merge is not possible. Both
 * devices decide from the same two file entries, so they agree.
 */
export function decideConflict(f: ConflictFacts): { localWins: boolean; keepCopy: boolean } {
  const { local, remote } = f;
  // One side deleted the very copy the other still has, and then made a
  // new file under the name (see TombstoneStore.revive): the new file wins,
  // and the deleted copy is not kept again as a conflict copy.
  if (f.revivedHash && f.revivedHash === remote.hash) return { localWins: true, keepCopy: false };
  if (remote.revives?.hash && remote.revives.hash === local.hash) return { localWins: false, keepCopy: false };
  // Both devices last had the same version in common, and one of them
  // still has it: the file was changed on the other side only, so that
  // side wins whatever the times say, and the old version is not kept
  // again as a copy. This is the case of a device that lost the notes'
  // sync history. A device that names none (it lost everything, or runs an
  // older version) cannot tell. When only one side names it (a file sent
  // live and changed before the two listed their files again), that side's
  // word is enough: a side that still has the version they last shared did
  // not change it. Each device reads the same two claims, so both decide
  // alike.
  const mine = f.agreed;
  const theirs = remote.agreed;
  const has = (hash: string) => (!!mine && hash === mine) || (!!theirs && hash === theirs);
  if (!mine || !theirs || mine === theirs) {
    const localSame = has(local.hash);
    const remoteSame = has(remote.hash);
    if (remoteSame && !localSame) return { localWins: true, keepCopy: false };
    if (localSame && !remoteSame) return { localWins: false, keepCopy: false };
  }
  // Changed on both sides: the version made later wins. When both lists
  // say when each version was made (FileMeta.madeAt), that is used: it is
  // the same on every device that has the version, so every device that
  // meets the other version decides alike. A device's modified time of a
  // version it received is when it wrote it, by its own clock, and differs
  // from device to device. A peer that does not send it (an older version)
  // decides by modified times, so then do we.
  const made = isTime(local.madeAt) && isTime(remote.madeAt);
  return {
    localWins: localIsWinner(
      made ? local.madeAt! : local.mtime,
      made ? remote.madeAt! : remote.mtime,
      f.deviceId,
      f.remoteDeviceId,
    ),
    keepCopy: true,
  };
}
