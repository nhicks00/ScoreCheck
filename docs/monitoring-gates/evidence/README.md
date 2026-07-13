# July 13 Router Evidence

`2026-07-13-speedify-fail-closed.tsv` is the completed, credential-free router
counter log copied from
`/root/scorecheck-speedify-fail-closed-20260713T1236Z.tsv` after the recorder
wrote its completion marker.

Integrity:

- Complete artifact: 533 lines, 86,231 bytes.
- Complete SHA-256:
  `c54cde22053ec6222effb7fa54678a44b170bb57ef811eef2726a8f73805fc24`.
- User-directed 16:00 CDT endpoint prefix: first 502 lines.
- Endpoint-prefix SHA-256:
  `e55d6a49dad6e7944b6ec15bea20ee5606147e2d7b5d5231f10dbee921281627`.

The recorder continued through 21:32:17Z, after the user-directed 21:01Z-21:02Z
final checkpoint. Those trailing samples preserve recorder shutdown evidence but
do not extend the qualification window. The TSV contains route/interface
counters, health states, process counts, and host resource values only. It does
not contain credentials or media payloads.
