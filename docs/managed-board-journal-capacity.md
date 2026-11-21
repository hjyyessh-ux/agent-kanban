# Managed board journal capacity (isolated candidate)

The journal now admits at most 100,000 event identities, 1,000 subscriptions, and
100,000 completed or reserved delivery receipts per file in new use. These numeric
ceilings are not estimates of disk bytes or supported traffic. The constructor can
supply lower bounds for synthetic tests. Immutable duplicate event replay, existing
subscription reads, nonexpired reserved pages, and saved ACK replay are allowed at the ceiling.
Unread expired pages remain unavailable; expiry is durably recorded before the
request is refused and a regressed wall clock cannot revive their payloads.
A delivery reserves its receipt before serving data; an existing reservation
can still be acknowledged when a journal is reopened with a lower test bound.
A database already over capacity is preserved, not trimmed.

The 30-day event payload policy is also applied on successful new appends; event
identity keys still preserve deduplication and truthful coverage after expiry.
No operation deletes a saved ACK or rewinds a cursor to make room. New admissions
stop with an explicit capacity error rather than silently skipping change events.
A blocked producer's atomic board outbox keeps the remainder queued, subject to
its separate configured admission ceiling.

This change is a safety guard, not a complete retention, rotation, or availability
policy. At a lifetime ceiling there is no automated capacity recovery. Ship no
general activation before verified operator visibility and a loss-accounted
rollover that preserves subscription checkpoint and protects pending producer
intents and legitimate retries. SQLite file/WAL sizes and recovery plan artifacts
are not bounded in bytes by this change.

`capacityDiagnostics()` is for a trusted local caller, not a remote endpoint. It
reports used and reserved counts, remaining slots, and flags at 80% and 100%.
Its SQLite logical-byte count is database page count × page size, not an upper
bound or WAL usage. A testing or provisioning host can alert on `near_capacity`
without exposing other projects' activity on scoped HTTP. At `saturated`,
retain the journal and pending records; there is no supported reset/rotation.

Planning examples, not workload measurements: a shared 100,000-key file at 100,
1,000, or 5,000 mutations/day fills in 1,000, 100, or 20 days. With 100 consumer
subscriptions each receiving a nonempty delivery 24 times/day, 100,000 ACK
slots last at most 42 days; at one such subscription the same budget is about
11.4 years. Actual page count can include empty deliveries that move the global
high watermark. Neither time estimates nor row limits bound physical file size:
WAL growth, physical compaction, and durable recovery artifacts need a separately
verified byte limit and operational action before the threshold.

`checkpointStorage()` is an explicit local, no-wait SQLite WAL checkpoint.
It reports physical database/WAL sizes at observation time. If an open reader
prevents truncation, report `busy` and return without terminating that reader.
Retry only after the holder releases its snapshot. Reclaiming an idle WAL
does not trim application rows, suspend capture, or alter pending/ACK state.
There is no automatic invocation in the request path or startup.

A safe rollover is not defined for current permanent event-key and ACK retry
semantics. For a future design, stop admitting new deliveries and coordinate
producer quiescence under the storage owner. Prove all pending work and active
consumer checkpoints have a verified durable successor or retain the original;
do not treat a successful backup, an idle WAL, or drained producer queues as
proof of consumer ACK. Validate identity, cutoff, deduplication, and data
availability at the successor before switching. A failed verification must
leave the original authoritative. No live rollover, physical byte ceiling, or
destructive export/import procedure is implemented by this candidate.
