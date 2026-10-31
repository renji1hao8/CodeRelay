# Copy to config.local.ps1. Keep that file private.
$BackendPort=8787
$ListenHost='127.0.0.1' # Use 0.0.0.0 only for trusted-LAN access.
$PublicUrl='' # Optional HTTPS or private-network address for the phone.
$Roots='' # Semicolon-separated project folders. Empty exposes only App files.
$ReadOnlyRoots=''
$ListDir=Join-Path $ServerDir 'data\list'
$HttpProxy='' # Optional HTTP proxy; direct connections are the default.
# Optional local stack (otherwise neither application is started):
$CcSwitchExe=''
$ClashVergeExe=''
$EnableAccounts=$false
$EnableElevation=$false
$EnableWebDav=$false
$EnableLegacyCli=$false
