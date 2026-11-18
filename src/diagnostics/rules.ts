/**
 * The decision rules a log record's `rule` names (plan 5.4), with what each
 * means. The diagnostics export carries this list, so a log can be read
 * without the source code.
 */
export const LOG_RULES: Record<string, string> = {
  "text-merge": "Note changed on both sides with a shared history: merged.",
  "text-no-history-winner": "Note differs and the two copies share no history: ours is kept (later, or changed here only).",
  "text-no-history-loser": "Note differs and the two copies share no history: the peer's is taken; ours is kept if it was changed here.",
  "full-state-adopted": "A peer's unrelated note history replaced ours; our text was kept as a version.",
  "full-state-kept-local": "A peer's unrelated note history lost to ours; ours was sent back.",
  "apart-edits": "The same lines were edited on two devices while apart: the later edit wins, the other is a conflict copy.",
  "binary-agreed": "Attachment changed on one side only (by the version both last shared): that side's is taken.",
  "binary-made-at": "Attachment changed on both sides: the later version wins, the other is a conflict copy.",
  "binary-newer": "Attachment fetched because the peer's version was chosen.",
  "remote-only": "File only the peer has: fetched.",
  "live-write": "A peer's change sent while both were connected.",
  "live-delete": "A peer's deletion sent while both were connected.",
  "live-rename": "A peer's rename sent while both were connected.",
  "follow-rename": "A rename made on a peer, followed here.",
  "deleted-after-rename": "A peer renamed a file that was then deleted here.",
  "deleted-while-stopped": "A file deleted here while sync was off; the deletion is sent to peers.",
  "tombstone-covers": "A file a peer deleted, with the same content as ours: deleted here.",
  "own-tombstone-skip": "A file deleted here that a peer still has: not fetched back; the peer deletes it.",
  "bulk-delete": "Many deletions at once: held for the user to confirm.",
  "held-kept": "Held deletions the user chose to keep.",
  "empty-folder": "A folder left empty by a peer's deletions.",
  "case-clash": "A peer's file whose name differs only in case from one here: not stored on this device.",
  "unportable-name": "A file whose name other devices cannot store: not synced.",
  "duplicate-device-id": "Another device uses this device's ID; the two cannot sync until one gets a new ID.",
  "content-shrank": "A sync write emptied a note or cut it below half: the old version was kept.",
  "history-near-cap": "Version history is near its size limit.",
  "restore": "A version restored from the recovery center.",
  "keep-failed": "The old version could not be kept, so the change was not made.",
  "write-failed": "Writing a file failed.",
  "too-large": "A peer's file over this device's size limit for received files (maxReceiveMB): refused before any of it was kept.",
  "bad-hash": "A large file arrived whole but did not match the hash the peer sent: discarded, the file here was left as it was.",
};
