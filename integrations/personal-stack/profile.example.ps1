# Copy selected settings to deploy/config.local.ps1; keep the filled file private.
$Roots='C:\Projects\Demo'
$ReadOnlyRoots='C:\Projects\Demo'
$HttpProxy='http://127.0.0.1:7890'
$EnableAccounts=$true
# Optional programs for the advanced bootstrap chain. Empty means do not start.
$CcSwitchExe=''
$ClashVergeExe=''
# Do not use whole-drive roots unless you intend the paired phone to browse them.
