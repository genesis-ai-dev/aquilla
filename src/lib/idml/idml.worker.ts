/// <reference lib="webworker" />

// The shared package installs its strict request protocol on WorkerGlobalScope
// as a side effect. Keeping this entry tiny guarantees browser imports and
// exports execute the same runtime-neutral engine used by Node conformance.
import "@aquilla/idml-roundtrip/worker"
