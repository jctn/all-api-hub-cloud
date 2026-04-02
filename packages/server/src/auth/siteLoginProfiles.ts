// Resolve to the shared source file directly so tsup DTS bundling does not
// depend on workspace package type resolution inside Docker/Zeabur.
export {
  matchOrDefaultSiteLoginProfile,
  matchSiteLoginProfile,
  parseSiteLoginProfiles,
  requiresLocalBrowserExecution,
  type SiteExecutionMode,
  type SiteLoginProfile,
  type SiteLoginProfileMap,
} from "../../../browser/src/siteLoginProfiles.js"
