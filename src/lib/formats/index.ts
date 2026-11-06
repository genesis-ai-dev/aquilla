// The shared format contract (AQU-2384). Import from here, not from the
// individual filter modules — `./registry` code-splits them on purpose.
export type {
  FormatBuildCell,
  FormatBuildResult,
  FormatFilter,
  FormatParseOptions,
  FormatParseResult,
  FormatRuntime,
  FormatRuntimes,
  FormatSkeleton,
  FormatSource,
  RoundTripFidelity,
} from "./contract"
export {
  FormatSkeletonMismatchError,
  assertSkeletonMatches,
  skeletonBytes,
  skeletonText,
} from "./contract"
export type { FormatDescriptor } from "./descriptors"
export {
  FORMAT_DESCRIPTORS,
  descriptorById,
  descriptorForExtension,
  descriptorForFileName,
  domOnlyParseFormatIds,
  extensionOfFileName,
  normalizeExtension,
  universallyParseableFormatIds,
} from "./descriptors"
export type { PartnerFormatFilterRegistration } from "./partner-contract"
export {
  boundFormatIds,
  filterForExtension,
  filterForFileName,
  filterForFormatId,
  partnerFormatExtensions,
  registeredFormatIds,
} from "./registry"
