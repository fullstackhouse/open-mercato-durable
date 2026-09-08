// What happens if core's engine stops behaving the way the adopter decorates it.
//
// An earlier version of this compared version strings by walking up from `require.resolve` to
// find core's manifest. That was wrong twice over: bundlers cannot statically resolve a
// computed `require`, so it broke the app build outright — and a version string is not the
// thing worth checking. The install-time guard is the peer range (`>=0.7.0 <0.8.0`), which the
// package manager enforces; the build-time guard is `gen:mirror --check` and the seam probe in
// `src/compat`, which read core's actual source.
//
// What is left for runtime is the case none of those catch: core still installs, still builds,
// still passes the probes, but a decorated method has stopped doing what the adopter relies on.
// The signature of that is specific enough to detect, and detecting it matters, because the
// failure it produces is silent — a run that reports success while its domain row says
// something else.

/** Thrown when core finalized a run itself instead of letting the adopter record it. */
export class SeamBrokenError extends Error {
  readonly durableErrorClass = 'terminal' as const
  constructor(readonly runId: string, detail: string) {
    super(
      `@fullstackhouse/open-mercato-data-sync-durable could not take over run ${runId}: ${detail}. ` +
        `This package decorates @open-mercato/core's data_sync engine and one of the contracts it relies on has changed. ` +
        `Install the package line matching the installed core minor, or report the change — see docs/adr/0004.`,
    )
    this.name = 'SeamBrokenError'
  }
}
